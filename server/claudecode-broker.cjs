#!/usr/bin/env node
"use strict";

// Singleton broker that manages persistent Claude Code CLI (`claude`) sessions,
// enforces parallel job concurrency (default 2), handles stream-json parsing,
// tracks live progress, manages dynamic model resolution against the local
// Anthropic-compatible gateway, and executes graceful cancellations.

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawn, execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const SERVER = { name: "claudecode-broker", version: "0.1.0" };
const BROKER_PORT = Number(process.env.CCB_BROKER_PORT || 19226);
const MAX_PARALLEL_JOBS = Number(process.env.CCB_MAX_PARALLEL_JOBS || 2);
const IDLE_EXIT_MS = Number(process.env.CCB_BROKER_IDLE_MS || 0); // 0 = persistent daemon (no auto-exit)
const JOB_TTL_MS = 60 * 60_000;
const TASK_IDLE_TIMEOUT_MS = Number(process.env.CCB_TASK_IDLE_TIMEOUT_MS || 10 * 60_000);
const TASK_TOOL_IDLE_TIMEOUT_MS = Number(process.env.CCB_TASK_TOOL_IDLE_TIMEOUT_MS || 60 * 60_000);
const TASK_HARD_TIMEOUT_MS = Number(process.env.CCB_TASK_TIMEOUT_MS || 4 * 60 * 60_000);
const configuredDefaultTimeoutMinutes = Number(process.env.CCB_DEFAULT_TIMEOUT_MINUTES || 240);
const DEFAULT_TIMEOUT_MINUTES = Number.isFinite(configuredDefaultTimeoutMinutes) && configuredDefaultTimeoutMinutes > 0
  ? configuredDefaultTimeoutMinutes
  : 240;
const MAX_OUTPUT_CHARS = 120_000;
const MODELS_CACHE_TTL_MS = Number(process.env.CCB_MODELS_CACHE_TTL_MS || 5 * 60_000);
const GATEWAY_TIMEOUT_MS = Number(process.env.CCB_GATEWAY_TIMEOUT_MS || 12_000);
const GATEWAY_RETRIES = Number(process.env.CCB_GATEWAY_RETRIES || 2);
const GATEWAY_BACKOFF_MS = Number(process.env.CCB_GATEWAY_BACKOFF_MS || 800);

function resolveHostUserProfile() {
  if (process.env.CCB_USER_PROFILE && fs.existsSync(process.env.CCB_USER_PROFILE)) {
    return process.env.CCB_USER_PROFILE;
  }
  const defaultProfile = "C:\\Users\\15869";
  if (fs.existsSync(defaultProfile)) return defaultProfile;
  return os.homedir();
}

const HOST_USER_PROFILE = resolveHostUserProfile();

// Enforce that broker only runs under the interactive authenticated host user
function assertHostUserSecurity(options = {}) {
  const current = (options.testUsername || os.userInfo().username || "").toLowerCase();
  const host = path.basename(HOST_USER_PROFILE).toLowerCase();
  if (current.includes("sandbox") || (current !== host && current !== "system")) {
    const msg = `FATAL: claudecode-broker cannot run under sandbox user '${current}'. It must run under host user '${host}' to access Claude Code credentials and desktop display.`;
    if (options.throwInsteadOfExit) {
      const err = new Error(msg);
      err.code = "ESANDBOXUSER";
      err.exitCode = 42;
      throw err;
    }
    process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
    process.exit(42);
  }
}

function resolveClaudeExe() {
  const candidates = [
    process.env.CCB_CLAUDE_EXE,
    // Existing machine-wide convention for locating the Claude Code binary.
    process.env.CODEXHOST_CLAUDE_COMMAND,
    "E:\\Node.js\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    path.join(HOST_USER_PROFILE, ".local", "bin", "claude.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "claude";
}

const CLAUDE_EXE = resolveClaudeExe();

function getClaudeEnv() {
  const env = { ...process.env };
  env.USERPROFILE = HOST_USER_PROFILE;
  env.HOME = HOST_USER_PROFILE;
  const root = path.parse(HOST_USER_PROFILE).root || "C:\\";
  env.HOMEDRIVE = root.replace(/[\/\\]$/, "");
  env.HOMEPATH = HOST_USER_PROFILE.slice(env.HOMEDRIVE.length);
  env.APPDATA = path.join(HOST_USER_PROFILE, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(HOST_USER_PROFILE, "AppData", "Local");

  // The Anthropic-compatible gateway usually listens on loopback; make sure any
  // ambient HTTP proxy never intercepts local requests. Never inject a proxy.
  if (!env.NO_PROXY) {
    env.NO_PROXY = "localhost,127.0.0.1,::1";
    env.no_proxy = "localhost,127.0.0.1,::1";
  } else if (!env.NO_PROXY.includes("127.0.0.1")) {
    env.NO_PROXY = `${env.NO_PROXY},127.0.0.1`;
    env.no_proxy = `${env.no_proxy || env.NO_PROXY},127.0.0.1`;
  }

  return env;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// In-memory data store
const sessions = new Map(); // sessionId -> Session
const jobs = new Map();     // jobId -> Job
const clients = new Set();
let activeSlots = 0;
const slotWaiters = [];
let lastActivity = Date.now();

// Session Event Stream Directory for Real-Time CLI Window Monitor
const SESSIONS_LOG_DIR = path.join(os.tmpdir(), "claudecode-sessions");
try { fs.mkdirSync(SESSIONS_LOG_DIR, { recursive: true }); } catch { /* ignore */ }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BROKER_LOG = process.env.CCB_BROKER_LOG || path.join(os.tmpdir(), "claudecode-broker.log");
function logEvent(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(BROKER_LOG, line); } catch { /* best-effort log */ }
}

function safeTail(value) {
  if (!value) return "";
  return value.length <= MAX_OUTPUT_CHARS ? value : `[output truncated]\n${value.slice(-MAX_OUTPUT_CHARS)}`;
}

function redactSensitive(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/(['"]?(?:authorization|x-api-key|api[_-]?key|token)['"]?\s*:\s*['"])[^'"\r\n]*(['"])/gi, "$1[REDACTED]$2");
}

function resolveWorkspace(input) {
  if (!input || typeof input !== "string") throw new Error("workspace is required");
  const workspace = path.resolve(input);
  if (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspace}`);
  }
  return workspace;
}

// ---------------------------------------------------------------------------
// Model Discovery & Family Aggregation (Anthropic-compatible gateway /v1/models)
//
// Claude Code has no headless `claude models` command, but this machine routes
// Claude Code through a local Anthropic-compatible gateway. When gateway model
// discovery is available we aggregate /v1/models into families; otherwise the
// built-in alias catalog is served.

function getEffortScore(slug, name) {
  const text = `${slug} ${name}`.toLowerCase();
  if (text.includes("thinking") || text.includes("high")) return 3;
  if (text.includes("medium")) return 2;
  if (text.includes("low")) return 1;
  return 0;
}

function getBaseFamilyName(name) {
  return String(name)
    .replace(/\s*\((High|Medium|Low|Thinking|.*mapping.*)\)\s*$/i, "")
    .replace(/\s*-\s*(High|Medium|Low|Thinking)\s*$/i, "")
    .trim();
}

function makeWorkerName(baseName) {
  const clean = baseName.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `cc_${clean}_worker`;
}

// Model Cache Defaults (Claude Code aliases; resolved by the CLI against the
// user's own settings, so these never block and always work)
const DEFAULT_MODEL_FAMILIES = [
  {
    worker_name: "cc_sonnet_worker",
    model_family: "Sonnet",
    target_model: "sonnet",
    description: "Claude Sonnet (alias — resolves to user-configured Sonnet mapping)",
    effort: null,
  },
  {
    worker_name: "cc_opus_worker",
    model_family: "Opus",
    target_model: "opus",
    description: "Claude Opus (alias — resolves to user-configured Opus mapping)",
    effort: null,
  },
  {
    worker_name: "cc_haiku_worker",
    model_family: "Haiku",
    target_model: "haiku",
    description: "Claude Haiku (alias — resolves to user-configured Haiku mapping)",
    effort: null,
  },
  {
    worker_name: "cc_fable_worker",
    model_family: "Fable",
    target_model: "fable",
    description: "Claude Fable (alias — resolves to user-configured Fable mapping)",
    effort: null,
  },
];

// Fast-path model alias dictionary to completely skip gateway discovery on dispatch
const KNOWN_MODEL_ALIASES = {
  "sonnet": { model: "sonnet", effort: null },
  "cc_sonnet_worker": { model: "sonnet", effort: null },
  "opus": { model: "opus", effort: null },
  "cc_opus_worker": { model: "opus", effort: null },
  "haiku": { model: "haiku", effort: null },
  "cc_haiku_worker": { model: "haiku", effort: null },
  "fable": { model: "fable", effort: null },
  "cc_fable_worker": { model: "fable", effort: null },
  "default": { model: null, effort: null },
};

// Persistent Cache Paths & Helpers
const MODELS_CACHE_DIR = process.env.CCB_CACHE_DIR || path.join(HOST_USER_PROFILE, ".claudecode-codex-bridge");
const MODELS_CACHE_FILE = process.env.CCB_MODELS_CACHE_FILE || path.join(MODELS_CACHE_DIR, "models-cache.json");

function loadPersistentCache(cacheFile = MODELS_CACHE_FILE) {
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, "utf8");
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.model_families) && data.model_families.length > 0) {
        return {
          timestamp: Number(data.timestamp) || 0,
          updated_at: data.updated_at || new Date(data.timestamp || 0).toISOString(),
          source: data.source || "file_cache",
          model_families: data.model_families,
          raw_count: data.raw_count || 0,
        };
      }
    }
  } catch (err) {
    logEvent(`failed to load persistent models cache from ${cacheFile}: ${err?.message || err}`);
  }
  return null;
}

function savePersistentCache(modelFamilies, rawCount = 0, cacheFile = MODELS_CACHE_FILE) {
  try {
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {
      version: 1,
      timestamp: Date.now(),
      updated_at: new Date().toISOString(),
      source: "gateway_models_api",
      raw_count: rawCount,
      families_count: modelFamilies.length,
      model_families: modelFamilies.map((m) => {
        const { stale, diagnostics, source, ...rest } = m;
        return rest;
      }),
    };
    const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpFile, cacheFile);
    return true;
  } catch (err) {
    logEvent(`failed to save persistent models cache to ${cacheFile}: ${err?.message || err}`);
    return false;
  }
}

// Global in-memory cache and diagnostic tracking
let lastSuccessfulModels = null;
let lastSuccessfulTimestamp = 0;
let lastSuccessfulSource = "built_in_defaults";
let lastModelQueryDiagnostic = {
  timestamp: Date.now(),
  status: "initial",
  reason: null,
  error: null,
  source: "built_in_defaults",
};

// Attempt to load persistent cache on startup
const initialDiskCache = loadPersistentCache();
if (initialDiskCache) {
  lastSuccessfulModels = [...initialDiskCache.model_families];
  lastSuccessfulTimestamp = initialDiskCache.timestamp;
  lastSuccessfulSource = "file_cache";
  lastModelQueryDiagnostic = {
    timestamp: initialDiskCache.timestamp,
    status: "success",
    reason: null,
    error: null,
    source: "file_cache",
    count: initialDiskCache.model_families.length,
  };
  logEvent(`loaded ${initialDiskCache.model_families.length} model families from persistent cache (${MODELS_CACHE_FILE})`);
}

let cachedModels = lastSuccessfulModels ? [...lastSuccessfulModels] : [...DEFAULT_MODEL_FAMILIES];
let cachedModelsTime = lastSuccessfulTimestamp;

// Gateway configuration: env override first, then the host user's Claude Code
// settings.json env block, then sane loopback defaults.
function getGatewayConfig() {
  const config = {
    baseUrl: process.env.CCB_GATEWAY_BASE_URL || null,
    token: process.env.CCB_GATEWAY_AUTH_TOKEN || process.env.CCB_GATEWAY_TOKEN || null,
    source: "env",
  };
  if (config.baseUrl && config.token) return config;

  try {
    const settingsPath = path.join(HOST_USER_PROFILE, ".claude", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settingsEnv = JSON.parse(fs.readFileSync(settingsPath, "utf8")).env || {};
      if (!config.baseUrl && settingsEnv.ANTHROPIC_BASE_URL) {
        config.baseUrl = settingsEnv.ANTHROPIC_BASE_URL;
        config.source = "claude_settings";
      }
      if (!config.token) {
        config.token = settingsEnv.ANTHROPIC_AUTH_TOKEN || settingsEnv.ANTHROPIC_API_KEY || null;
      }
    }
  } catch (err) {
    logEvent(`failed to read Claude settings.json for gateway config: ${err?.message || err}`);
  }

  if (!config.baseUrl && process.env.ANTHROPIC_BASE_URL) {
    config.baseUrl = process.env.ANTHROPIC_BASE_URL;
    config.source = "env";
  }
  if (!config.token && (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY)) {
    config.token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  }
  return config;
}

function categorizeGatewayError(err, body = "") {
  const status = err?.statusCode;
  const fullText = `${err?.message || ""} ${body}`.toLowerCase();
  if (
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNABORTED" ||
    fullText.includes("timed out") ||
    fullText.includes("timeout")
  ) {
    return {
      reason: "timeout",
      message: `Gateway query timed out after ${GATEWAY_TIMEOUT_MS}ms`,
    };
  }
  if (status === 401 || status === 403 || fullText.includes("unauthorized") || fullText.includes("forbidden")) {
    return {
      reason: "auth_permission",
      message: `Gateway rejected credentials (HTTP ${status || "?"})`,
    };
  }
  if (status === 429 || fullText.includes("rate limit") || fullText.includes("too many requests")) {
    return {
      reason: "rate_limited",
      message: `Gateway rate limited the models query (HTTP 429)`,
    };
  }
  if (err?.code === "ECONNREFUSED" || fullText.includes("econnrefused")) {
    return {
      reason: "gateway_unreachable",
      message: `Gateway refused connection — is the local proxy/gateway running? (${err?.message || "ECONNREFUSED"})`,
    };
  }
  return {
    reason: "unknown_error",
    message: err?.message || body || "Unknown error during gateway models query",
  };
}

function fetchGatewayModelsOnce(config) {
  return new Promise((resolve) => {
    if (!config.baseUrl) {
      return resolve({
        success: false,
        reason: "gateway_not_configured",
        message: "No Anthropic-compatible gateway configured (set CCB_GATEWAY_BASE_URL or ANTHROPIC_BASE_URL in ~/.claude/settings.json)",
        models: [],
      });
    }

    const base = config.baseUrl.replace(/\/+$/, "");
    let url;
    try {
      url = new URL(`${base}/v1/models`);
    } catch {
      return resolve({
        success: false,
        reason: "invalid_base_url",
        message: `Invalid gateway base URL: ${config.baseUrl}`,
        models: [],
      });
    }

    const requestHeaders = { "Accept": "application/json", "anthropic-version": "2023-06-01" };
    if (config.token) {
      requestHeaders["x-api-key"] = config.token;
      requestHeaders["Authorization"] = `Bearer ${config.token}`;
    }

    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: requestHeaders,
        timeout: GATEWAY_TIMEOUT_MS,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const cat = categorizeGatewayError({ statusCode: response.statusCode }, body);
            return resolve({ success: false, ...cat, models: [] });
          }
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            return resolve({
              success: false,
              reason: "malformed_output",
              message: "Gateway /v1/models returned non-JSON payload",
              models: [],
            });
          }
          const rawList = Array.isArray(parsed?.data) ? parsed.data : null;
          if (!rawList || rawList.length === 0) {
            return resolve({
              success: false,
              reason: "empty_output",
              message: "Gateway /v1/models returned an empty model list",
              models: [],
            });
          }
          const rawParsed = [];
          for (const entry of rawList) {
            if (!entry || typeof entry.id !== "string") continue;
            rawParsed.push({
              slug: entry.id.trim(),
              name: String(entry.display_name || entry.id).trim(),
              owned_by: entry.owned_by || null,
            });
          }
          const validation = validateRawModels(rawParsed);
          if (!validation.valid) {
            return resolve({ success: false, reason: validation.reason, message: validation.message, models: [] });
          }
          resolve({ success: true, models: validation.models, rawCount: validation.uniqueCount });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Gateway query timed out after ${GATEWAY_TIMEOUT_MS}ms`));
    });
    request.on("error", (err) => {
      const cat = categorizeGatewayError(err);
      resolve({ success: false, ...cat, models: [] });
    });
    request.end();
  });
}

function validateRawModels(rawModels) {
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    return { valid: false, reason: "empty_output", message: "Model list is empty" };
  }

  const slugRegex = /^[a-z0-9][a-z0-9_.-]{1,128}$/i;
  const validModels = [];
  const seenSlugs = new Set();
  let duplicateCount = 0;

  for (const m of rawModels) {
    if (!m || typeof m.slug !== "string" || typeof m.name !== "string") continue;
    const slug = m.slug.trim();
    const name = m.name.trim();
    if (!slug || !name) continue;
    const lowerSlug = slug.toLowerCase();
    if (
      lowerSlug.startsWith("fetching") ||
      lowerSlug.startsWith("warning") ||
      lowerSlug.startsWith("error") ||
      lowerSlug.includes("failed") ||
      lowerSlug.includes("unauthorized")
    ) {
      continue;
    }
    if (!slugRegex.test(slug)) continue;

    if (seenSlugs.has(lowerSlug)) {
      duplicateCount++;
      continue;
    }
    seenSlugs.add(lowerSlug);
    validModels.push({ slug, name, owned_by: m.owned_by || null });
  }

  if (validModels.length === 0) {
    return {
      valid: false,
      reason: "malformed_output",
      message: "No valid model entries parsed from gateway response",
    };
  }

  // Anomaly check: duplicate flood (e.g. corrupt payload repeating identical entries)
  if (rawModels.length >= 8 && duplicateCount > validModels.length * 2) {
    return {
      valid: false,
      reason: "anomaly_duplicate_flood",
      message: `Excessive duplicate model entries detected (${duplicateCount} duplicates vs ${validModels.length} unique)`,
    };
  }

  return { valid: true, models: validModels, uniqueCount: validModels.length };
}

function validateFamilyQuality(newFamilies, previousFamilies) {
  if (!Array.isArray(newFamilies) || newFamilies.length === 0) {
    return {
      acceptable: false,
      reason: "empty_families",
      message: "No model families could be constructed from raw models",
    };
  }

  for (const f of newFamilies) {
    if (!f.worker_name || !f.model_family || !f.target_model) {
      return {
        acceptable: false,
        reason: "malformed_family_structure",
        message: `Model family missing required fields: ${JSON.stringify(f)}`,
      };
    }
  }

  // Relative completeness check against previous successful cache
  if (previousFamilies && Array.isArray(previousFamilies) && previousFamilies.length >= 3) {
    const minAcceptableCount = Math.max(2, Math.floor(previousFamilies.length * 0.5));
    if (newFamilies.length < minAcceptableCount) {
      return {
        acceptable: false,
        reason: "partial_result",
        message: `Suspected partial model discovery: returned ${newFamilies.length} families vs ${previousFamilies.length} previously cached (< 50% threshold: ${minAcceptableCount})`,
      };
    }
  }

  return { acceptable: true };
}

async function fetchGatewayModelsWithRetry() {
  const maxAttempts = 1 + Math.max(0, GATEWAY_RETRIES);
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchGatewayModelsOnce(getGatewayConfig());
    if (result.success && result.models.length > 0) {
      if (attempt > 1) {
        logEvent(`gateway models query succeeded on retry attempt ${attempt}/${maxAttempts}`);
      }
      return result;
    }

    lastFailure = result;
    logEvent(`gateway models query attempt ${attempt}/${maxAttempts} failed (${result.reason}): ${result.message}`);

    if (result.reason === "auth_permission" || result.reason === "gateway_not_configured" || result.reason === "invalid_base_url") {
      break;
    }

    if (attempt < maxAttempts) {
      await sleep(GATEWAY_BACKOFF_MS * attempt);
    }
  }

  return lastFailure || { success: false, reason: "unknown", message: "All query attempts failed" };
}

let fetchModelsInFlight = null;
function fetchDynamicModelsSingleton() {
  if (fetchModelsInFlight) {
    return fetchModelsInFlight;
  }

  fetchModelsInFlight = (async () => {
    try {
      return await fetchGatewayModelsWithRetry();
    } finally {
      fetchModelsInFlight = null;
    }
  })();

  return fetchModelsInFlight;
}

function formatModelResponse(families, { stale, source, diagnostics, detailed }) {
  const modelsWithMeta = families.map((m) => ({
    ...m,
    stale: Boolean(stale),
    source: source || "unknown",
    ...(diagnostics ? { diagnostics } : {}),
  }));

  if (detailed) {
    return {
      models: modelsWithMeta,
      count: modelsWithMeta.length,
      stale: Boolean(stale),
      source: source || "unknown",
      diagnostics: diagnostics || null,
      timestamp: Date.now(),
    };
  }

  return modelsWithMeta;
}

async function getAvailableModelFamilies(params = {}) {
  const now = Date.now();
  const detailed = Boolean(params?.detailed);
  const force = Boolean(params?.force);

  // Return fresh memory cache if within TTL and not forcing refresh
  if (!force && lastSuccessfulModels && (now - lastSuccessfulTimestamp < MODELS_CACHE_TTL_MS) && lastSuccessfulTimestamp > 0) {
    return formatModelResponse(lastSuccessfulModels, {
      stale: false,
      source: lastSuccessfulSource,
      diagnostics: null,
      detailed,
    });
  }

  const queryResult = await fetchDynamicModelsSingleton();

  if (queryResult.success && queryResult.models && queryResult.models.length > 0) {
    const familyMap = new Map();
    for (const m of queryResult.models) {
      const family = getBaseFamilyName(m.name);
      if (!family) continue;
      const score = getEffortScore(m.slug, m.name);
      if (!familyMap.has(family) || familyMap.get(family).score < score) {
        const effortLabel = score === 3 ? (m.name.toLowerCase().includes("thinking") ? "Thinking" : "High") : score === 2 ? "Medium" : score === 1 ? "Low" : "Default";
        familyMap.set(family, {
          worker_name: makeWorkerName(family),
          model_family: family,
          target_model: m.slug,
          description: `${family} (${effortLabel === "Default" ? "gateway model" : `最高推理: ${effortLabel}`})${m.owned_by ? ` [${m.owned_by}]` : ""}`,
          effort: score === 3 ? "high" : score === 2 ? "medium" : score === 1 ? "low" : null,
          score,
        });
      }
    }

    const families = Array.from(familyMap.values()).map(({ score, ...rest }) => rest);
    const qualityCheck = validateFamilyQuality(families, lastSuccessfulModels);

    if (!qualityCheck.acceptable) {
      logEvent(`model family quality check rejected result (${qualityCheck.reason}): ${qualityCheck.message}`);
      queryResult.success = false;
      queryResult.reason = qualityCheck.reason;
      queryResult.message = qualityCheck.message;
    } else {
      lastSuccessfulModels = families;
      lastSuccessfulTimestamp = now;
      lastSuccessfulSource = "gateway_models_api";
      cachedModels = families;
      cachedModelsTime = now;
      lastModelQueryDiagnostic = {
        timestamp: now,
        status: "success",
        reason: null,
        error: null,
        source: "gateway_models_api",
        count: families.length,
      };

      savePersistentCache(families, queryResult.rawCount);

      return formatModelResponse(families, {
        stale: false,
        source: "gateway_models_api",
        diagnostics: null,
        detailed,
      });
    }
  }

  // Dynamic discovery failed!
  const diagReason = queryResult.reason || "unknown_failure";
  const diagMsg = queryResult.message || queryResult.error || "Dynamic model query failed";
  logEvent(`dynamic model discovery failed (${diagReason}): ${diagMsg}`);

  // PREFER PREVIOUS SUCCESSFUL CACHE (memory or persistent file cache)
  if (lastSuccessfulModels && lastSuccessfulModels.length > 0) {
    const ageSeconds = Math.max(0, Math.round((now - lastSuccessfulTimestamp) / 1000));
    const diagNote = `Dynamic query failed (${diagReason}: ${diagMsg}). Serving cached model list (${lastSuccessfulModels.length} models, age: ${ageSeconds}s, source: ${lastSuccessfulSource}).`;
    lastModelQueryDiagnostic = {
      timestamp: now,
      status: "stale",
      reason: diagReason,
      error: diagMsg,
      source: lastSuccessfulSource,
      cached_timestamp: lastSuccessfulTimestamp,
      count: lastSuccessfulModels.length,
    };
    cachedModels = lastSuccessfulModels;
    return formatModelResponse(lastSuccessfulModels, {
      stale: true,
      source: lastSuccessfulSource,
      diagnostics: diagNote,
      detailed,
    });
  }

  // ONLY USE BUILT-IN FALLBACK IF NEVER HAD SUCCESSFUL QUERY
  const fallbackNote = `Dynamic query failed (${diagReason}: ${diagMsg}) and no persistent cache is available. Serving built-in Claude Code alias defaults (sonnet/opus/haiku/fable).`;
  lastModelQueryDiagnostic = {
    timestamp: now,
    status: "fallback",
    reason: diagReason,
    error: diagMsg,
    source: "built_in_defaults",
    count: DEFAULT_MODEL_FAMILIES.length,
  };
  return formatModelResponse(DEFAULT_MODEL_FAMILIES, {
    stale: true,
    source: "built_in_defaults",
    diagnostics: fallbackNote,
    detailed,
  });
}

// Warm up dynamic models in background on startup so list_models gets full models instantly
if (require.main === module) {
  setTimeout(() => {
    getAvailableModelFamilies().then((families) => {
      const count = Array.isArray(families) ? families.length : families.count;
      logEvent(`warmup: discovered ${count} dynamic model families (source: ${lastSuccessfulSource})`);
    }).catch(() => {});
  }, 1500).unref();
}

// Resolution contract for Claude Code:
// - No model requested -> omit --model entirely; the CLI applies the user's own
//   configured default (settings.json / env), which is the safest behaviour on
//   gateway-proxied setups.
// - Alias requested -> pass straight through; the CLI maps aliases itself.
// - Gateway slug requested -> pass straight through.
async function resolveModelSelection(requestedModel) {
  if (!requestedModel || typeof requestedModel !== "string" || requestedModel.trim().toLowerCase() === "default") {
    return { model: null, effort: null };
  }

  const normalized = requestedModel.trim().toLowerCase();

  // FAST-PATH: Known alias mapping (resolves in 0ms without hitting the gateway)
  if (KNOWN_MODEL_ALIASES[normalized]) {
    return { ...KNOWN_MODEL_ALIASES[normalized] };
  }

  const stripped = normalized.replace(/^cc_/, "").replace(/_worker$/, "");
  if (KNOWN_MODEL_ALIASES[stripped]) {
    return { ...KNOWN_MODEL_ALIASES[stripped] };
  }

  // FALLBACK: consult discovered gateway families
  const families = await getAvailableModelFamilies();

  // 1. Direct match with worker_name, e.g. cc_gpt5.6luna_worker
  const byWorker = families.find((f) => f.worker_name.toLowerCase() === normalized);
  if (byWorker) return { model: byWorker.target_model, effort: byWorker.effort || null };

  // 2. Match stripped format, e.g. gpt5.6luna
  const byStripped = families.find((f) => f.worker_name.toLowerCase().includes(stripped));
  if (byStripped) return { model: byStripped.target_model, effort: byStripped.effort || null };

  // 3. Match base family name, e.g. "gpt 5.6 luna"
  const byFamily = families.find((f) => f.model_family.toLowerCase() === normalized);
  if (byFamily) return { model: byFamily.target_model, effort: byFamily.effort || null };

  // 4. Exact slug passthrough — the gateway / CLI is authoritative.
  return { model: requestedModel, effort: null };
}

// ---------------------------------------------------------------------------
// Concurrency Control (Semaphore)

function acquireSlot(job) {
  return new Promise((resolve) => {
    slotWaiters.push({ job, resolve });
    pumpSlots();
  });
}

function pumpSlots() {
  while (activeSlots < MAX_PARALLEL_JOBS && slotWaiters.length > 0) {
    const { job, resolve } = slotWaiters.shift();
    if (TERMINAL_STATUSES.has(job.status)) {
      resolve(false);
      continue;
    }
    activeSlots += 1;
    job.slotHeld = true;
    resolve(true);
  }
}

function releaseSlot(job) {
  if (!job.slotHeld) return;
  job.slotHeld = false;
  activeSlots -= 1;
  pumpSlots();
}

function dropSlotWaiter(job) {
  for (let i = slotWaiters.length - 1; i >= 0; i -= 1) {
    if (slotWaiters[i].job === job) {
      slotWaiters[i].resolve(false);
      slotWaiters.splice(i, 1);
    }
  }
}

function hasActiveJobs() {
  for (const job of jobs.values()) {
    if (!TERMINAL_STATUSES.has(job.status)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Process Tree Management & Cancellation

function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], (err) => {
        if (err) logEvent(`taskkill pid=${pid} notice: ${err.message}`);
        resolve();
      });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
      resolve();
    }
  });
}

async function terminateSessionProcess(session, reason) {
  if (!session || !session.process || session.processExited) return;
  const child = session.process;
  const pid = child.pid;
  logEvent(`terminating session ${session.sessionId} process (pid=${pid}) due to: ${reason}`);

  session.processExited = true;

  try { child.stdin?.end(); } catch { /* ignore */ }
  try { child.kill("SIGINT"); } catch { /* ignore */ }

  const start = Date.now();
  while (Date.now() - start < 2500) {
    if (session.processExited && !session.process) break;
    await sleep(200);
  }

  if (pid) {
    await killProcessTree(pid);
  }

  session.process = null;
}

// ---------------------------------------------------------------------------
// Real-Time CLI Window Monitor & Session Event Stream

function writeSessionEvent(session, event) {
  if (!session || !session.logPath) return;
  try {
    fs.appendFileSync(session.logPath, `${JSON.stringify(event)}\n`);
  } catch { /* best-effort write */ }
}

const VIEWER_SCRIPT = path.join(__dirname, "..", "scripts", "claudecode-viewer.cjs");

function launchSessionViewer(session) {
  if (process.platform !== "win32") return;
  if (process.env.CCB_SHOW_WINDOW === "0") return;
  if (session.viewerLaunched) return;
  session.viewerLaunched = true;

  try {
    const title = `Claude Code CLI Monitor - [${session.model || "configured default"}]`;
    const cmdArgs = [
      "/c",
      "start",
      title,
      process.execPath,
      VIEWER_SCRIPT,
      session.sessionId,
      session.logPath,
    ];
    const viewerProc = spawn("cmd.exe", cmdArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    viewerProc.unref();
    logEvent(`launched visible CLI monitor window for session ${session.sessionId}`);
  } catch (err) {
    logEvent(`failed to launch CLI monitor window: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Session & Subprocess Lifecycle

async function createSession({ workspace, model: rawModel, effort: rawEffort, agent, permissionMode, timeoutMinutes }) {
  const resolved = await resolveModelSelection(rawModel);
  const sessionId = `csess_${randomUUID()}`;
  const logPath = path.join(SESSIONS_LOG_DIR, `${sessionId}.jsonl`);
  const session = {
    sessionId,
    claudeSessionId: null, // native Claude Code session id (--resume handle)
    workspace: resolveWorkspace(workspace),
    model: resolved.model, // null = user-configured default
    effort: rawEffort || resolved.effort || null,
    agent: agent || null,
    permissionMode: permissionMode === "safe" ? "safe" : "yolo",
    timeoutMinutes: Number(timeoutMinutes) || DEFAULT_TIMEOUT_MINUTES,
    process: null,
    processExited: false,
    activeJobId: null,
    logPath,
    viewerLaunched: false,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, session);
  writeSessionEvent(session, {
    type: "meta",
    session_id: sessionId,
    model: session.model || "(configured default)",
    effort: session.effort || "default",
    workspace: session.workspace,
    started_at: session.createdAt,
  });
  return session;
}

let lastSpawnSlotPromise = Promise.resolve();

async function acquireSpawnSlot() {
  const previous = lastSpawnSlotPromise;
  let release;
  let resolved = false;
  lastSpawnSlotPromise = new Promise((r) => { release = r; });

  await previous;

  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      release();
    }
  }, 4000);

  return () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      release();
    }
  };
}

function buildClaudeArgs(session) {
  const args = [
    "--print",
    "--verbose",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
  ];

  if (session.permissionMode === "yolo") {
    args.push("--dangerously-skip-permissions");
  } else {
    // Headless-safe mode: auto-accept file edits; anything that would prompt is denied.
    args.push("--permission-mode", "acceptEdits");
  }

  if (session.model) {
    args.push("--model", session.model);
  }

  // Effort is only forwarded when explicitly requested: gateway-backed model
  // slugs often encode effort themselves and a stray --effort can break them.
  if (session.effort) {
    args.push("--effort", session.effort);
  }

  if (session.agent) {
    args.push("--agent", session.agent);
  }

  if (session.claudeSessionId) {
    args.push("--resume", session.claudeSessionId);
  }

  return args;
}

function spawnClaudeProcess(session) {
  const args = buildClaudeArgs(session);

  logEvent(`spawning claude in ${session.workspace} (model=${session.model || "configured-default"}, effort=${session.effort || "default"}, resume=${session.claudeSessionId || "none"})`);

  const child = spawn(CLAUDE_EXE, args, {
    cwd: session.workspace,
    env: getClaudeEnv(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  session.process = child;
  session.processExited = false;
  // Claude Code only emits its 'system/init' event AFTER the first user
  // message arrives on stdin (at spawn it emits hook_started/hook_response at
  // most), so startup liveness is tracked via the first stdout event instead.
  session.firstEventSeen = false;
  session.awaitingFirstEvent = false;
  session.startupExitInfo = null;
  session._firstEventWaiters = [];
  let stdoutBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const rawLine = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!rawLine) continue;
      handleClaudeEventLine(session, rawLine);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const activeJob = session.activeJobId ? jobs.get(session.activeJobId) : null;
    if (activeJob) {
      activeJob.stderr = safeTail(activeJob.stderr + chunk);
      activeJob.lastActivityMs = Date.now();
    }
    writeSessionEvent(session, { type: "stderr", text: chunk });
  });

  const handleStartupFailure = (error) => {
    session.processExited = true;
    if (!session.firstEventSeen && session.awaitingFirstEvent) {
      // executeJob owns the retry decision while awaiting the first event.
      session.startupExitInfo = error;
      for (const waiter of session._firstEventWaiters.splice(0)) {
        waiter.reject(error);
      }
      return true;
    }
    return false;
  };

  child.on("error", (error) => {
    logEvent(`session ${session.sessionId} claude process error: ${error.message}`);
    if (handleStartupFailure(error)) return;
    const activeJob = session.activeJobId ? jobs.get(session.activeJobId) : null;
    if (activeJob && !TERMINAL_STATUSES.has(activeJob.status)) {
      activeJob.status = "failed";
      activeJob.stderr = safeTail(`${activeJob.stderr}\n${error.stack || error.message}`);
      settleJob(activeJob);
    }
  });

  child.stdin.on("error", (error) => {
    logEvent(`session ${session.sessionId} claude stdin error: ${error.message}`);
    handleStartupFailure(error);
  });

  child.on("close", (code, signal) => {
    logEvent(`session ${session.sessionId} claude process closed (code=${code}, signal=${signal})`);
    session.processExited = true;
    session.process = null;
    const closeError = new Error(`claude CLI closed with code ${code}${signal ? ` (signal ${signal})` : ""} before producing any stream output`);
    if (handleStartupFailure(closeError)) return;

    const activeJob = session.activeJobId ? jobs.get(session.activeJobId) : null;
    if (activeJob && !TERMINAL_STATUSES.has(activeJob.status)) {
      if (activeJob.status === "cancelling") {
        activeJob.status = "cancelled";
      } else {
        activeJob.status = "failed";
        const detail = signal ? `by signal ${signal}` : `with exit code ${code}`;
        const reason = code === 0
          ? `Claude Code CLI process exited cleanly (${detail}) before providing a stream-json 'result' event. Job marked as failed.`
          : `Claude Code CLI process terminated unexpectedly (${detail}).`;
        activeJob.stderr = safeTail(`${activeJob.stderr}\n${reason} Native claude session '${session.claudeSessionId || "unknown"}' is preserved for lazy recovery via continue_task.`);
        activeJob.diagnostics = safeTail(`${activeJob.diagnostics || ""}\n${reason}`);
      }
      activeJob.exitCode = code;
      settleJob(activeJob);
    }
  });

  return child;
}

// Resolves once the claude process has produced its first stdout event, or
// after the timeout (a silent-but-alive process is left to the idle monitors).
// Rejects only when the process exits or errors before any output.
function waitForFirstStreamEvent(session, timeoutMs) {
  if (session.firstEventSeen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    session._firstEventWaiters.push(waiter);
    session.awaitingFirstEvent = true;
    const timer = setTimeout(() => {
      const index = session._firstEventWaiters.indexOf(waiter);
      if (index >= 0) {
        session._firstEventWaiters.splice(index, 1);
        if (session._firstEventWaiters.length === 0) session.awaitingFirstEvent = false;
        resolve();
      }
    }, timeoutMs);
    timer.unref?.();
  });
}

// Claude Code stream-json output schema:
//   {"type":"system","subtype":"init","session_id":...,"model":...}
//   {"type":"system","subtype":"api_retry"|"hook_started"|...}
//   {"type":"assistant","message":{"content":[{type:"text"|"thinking"|"tool_use",...}],"usage":{...}}}
//   {"type":"user","message":{"content":[{type:"tool_result",...}]}}
//   {"type":"result","subtype":"success"|...,"result":...,"session_id":...,"usage":...}
function handleClaudeEventLine(session, rawLine) {
  let message;
  try {
    message = JSON.parse(rawLine);
  } catch (err) {
    logEvent(`session ${session.sessionId} received invalid JSON: ${rawLine.slice(0, 100)}`);
    return;
  }

  if (!session.firstEventSeen) {
    session.firstEventSeen = true;
    session.awaitingFirstEvent = false;
    for (const waiter of session._firstEventWaiters.splice(0)) {
      waiter.resolve();
    }
  }

  const activeJob = session.activeJobId ? jobs.get(session.activeJobId) : null;
  if (!activeJob) return;

  activeJob.lastActivityMs = Date.now();

  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        if (message.session_id) {
          session.claudeSessionId = message.session_id;
          activeJob.claudeSessionId = message.session_id;
        }
        if (message.model) {
          activeJob.resolvedModel = message.model;
        }
        logEvent(`session ${session.sessionId} initialized claude session ${session.claudeSessionId} (model=${message.model || "?"})`);
        writeSessionEvent(session, { type: "init", conversation_id: session.claudeSessionId, model: message.model || null });
        break;
      }

      if (message.subtype === "api_retry") {
        activeJob.progress = {
          ...(activeJob.progress || {}),
          last_activity_age_s: 0,
          state: `api_retry (attempt ${message.attempt ?? "?"}/${message.max_retries ?? "?"})`,
        };
        writeSessionEvent(session, {
          type: "retry",
          attempt: message.attempt ?? null,
          max_retries: message.max_retries ?? null,
          error_status: message.error_status ?? null,
          error: redactSensitive(String(message.error || "")),
        });
        break;
      }

      writeSessionEvent(session, { type: "system", subtype: message.subtype });
      break;
    }

    case "assistant": {
      const contentBlocks = Array.isArray(message.message?.content) ? message.message.content : [];
      let hasToolUse = false;
      let hasThinking = false;
      let hasText = false;

      for (const block of contentBlocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && block.text) {
          hasText = true;
          activeJob.stdout = safeTail(activeJob.stdout + block.text);
          writeSessionEvent(session, { type: "text_delta", text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          hasThinking = true;
          writeSessionEvent(session, { type: "thought_delta", text: block.thinking });
        } else if (block.type === "tool_use") {
          hasToolUse = true;
          writeSessionEvent(session, {
            type: "tool_call",
            name: block.name,
            input: block.input,
            id: block.id || null,
            step_index: activeJob.progress?.step_index ?? null,
          });
        }
      }

      if (message.message?.usage) {
        const usage = message.message.usage;
        activeJob.usage = {
          ...activeJob.usage,
          input_tokens: usage.input_tokens ?? activeJob.usage?.input_tokens ?? null,
          output_tokens: (usage.output_tokens ?? 0) + (activeJob.usage?.output_tokens ?? 0),
          cache_read_tokens: usage.cache_read_input_tokens ?? activeJob.usage?.cache_read_tokens ?? null,
        };
      }

      const stepIndex = (activeJob.progress?.step_index ?? -1) + 1;
      activeJob.progress = {
        last_activity_age_s: 0,
        step_index: stepIndex,
        step_type: hasToolUse ? "tool" : hasThinking && !hasText ? "thinking" : "text",
        state: "streaming",
        total_tokens: (activeJob.usage?.input_tokens || 0) + (activeJob.usage?.output_tokens || 0) || null,
      };
      writeSessionEvent(session, {
        type: "step_progress",
        progress: activeJob.progress,
        timestamp: Date.now(),
      });
      break;
    }

    case "user": {
      // tool_result blocks come back wrapped in user messages
      const contentBlocks = Array.isArray(message.message?.content) ? message.message.content : [];
      for (const block of contentBlocks) {
        if (block && block.type === "tool_result") {
          const output = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
              : "";
          writeSessionEvent(session, {
            type: "tool_result",
            name: block.name || block.tool_use_id || "tool",
            output: output ? safeTail(String(output)) : "",
            id: block.tool_use_id || null,
            step_index: activeJob.progress?.step_index ?? null,
          });
        }
      }
      break;
    }

    case "result": {
      if (message.session_id) {
        session.claudeSessionId = message.session_id;
        activeJob.claudeSessionId = message.session_id;
      }
      const isSuccess = message.subtype === "success" && !message.is_error;
      if (typeof message.result === "string" && message.result.length > 0) {
        activeJob.response = message.result;
        activeJob.stdout = safeTail(message.result);
      }
      if (message.usage) {
        const usage = message.usage;
        activeJob.usage = {
          input_tokens: usage.input_tokens ?? null,
          output_tokens: usage.output_tokens ?? null,
          cache_read_tokens: usage.cache_read_input_tokens ?? null,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) || null,
        };
      }
      if (typeof message.total_cost_usd === "number") {
        activeJob.costUsd = message.total_cost_usd;
      }
      if (typeof message.num_turns === "number") {
        activeJob.numTurns = message.num_turns;
      }

      activeJob.exitCode = isSuccess ? 0 : 1;
      activeJob.status = isSuccess ? "completed" : "failed";
      if (!isSuccess && !activeJob.stderr) {
        activeJob.stderr = `Task ended with result subtype: ${message.subtype}${message.result ? ` — ${message.result}` : ""}`;
      }
      settleJob(activeJob);
      break;
    }

    default:
      logEvent(`session ${session.sessionId} received event: ${message.type}`);
      writeSessionEvent(session, { type: "system", subtype: message.type });
      break;
  }
}

function settleJob(job) {
  if (job.settled) return;
  job.settled = true;
  job.completedAt = new Date().toISOString();
  logEvent(`job ${job.jobId} settled with status: ${job.status}`);

  const session = sessions.get(job.sessionId);
  if (session) {
    const duration_s = Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000));
    writeSessionEvent(session, {
      type: "turn_complete",
      job_id: job.jobId,
      status: job.status,
      exit_code: job.exitCode,
      diagnostics: redactSensitive(job.stderr.trim()),
      usage: job.usage,
      duration_s,
    });
    if (session.activeJobId === job.jobId) {
      session.activeJobId = null;
      session.lastUsedAt = new Date().toISOString();
    }
  }

  releaseSlot(job);
}

// ---------------------------------------------------------------------------
// Job Dispatch & Execution

async function startJob(args, isContinue = false) {
  let session;
  if (isContinue) {
    const sessionId = args.session_id;
    if (!sessionId) throw new Error("session_id is required for continue_task");
    session = sessions.get(sessionId);
    if (!session) throw new Error(`unknown session_id: ${sessionId}`);
    if (session.activeJobId) {
      throw new Error(`session ${sessionId} already has an active job (${session.activeJobId}); please wait for it to complete`);
    }
  } else {
    session = await createSession(args);
  }

  const task = args.task;
  if (!task || typeof task !== "string" || !task.trim()) {
    throw new Error("task is required");
  }

  const timeoutMinutes = Number(args.timeout_minutes) || session.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES;
  const jobId = `cjob_${randomUUID()}`;
  const job = {
    jobId,
    sessionId: session.sessionId,
    claudeSessionId: session.claudeSessionId,
    workspace: session.workspace,
    model: session.model,
    prompt: task,
    timeoutMinutes,
    status: "queued",
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    response: null,
    usage: null,
    progress: null,
    lastActivityMs: Date.now(),
    slotHeld: false,
    settled: false,
    cancelRequested: false,
  };

  jobs.set(jobId, job);
  session.activeJobId = jobId;
  logEvent(`job ${jobId} created for session ${session.sessionId} (${isContinue ? "continue" : "new"}, timeout=${timeoutMinutes}m)`);

  void executeJob(job, session);
  return publicJob(job, false);
}

function wrapAutonomousPrompt(task) {
  return [
    "You are operating in autonomous execution mode in the shared workspace.",
    "Auto-approve and execute all required tool calls (edits, shell commands, inspections) directly without asking the user for interactive confirmation or pausing in plan mode.",
    "Complete the implementation and verification fully, then summarize the outcome and modified files.",
    "",
    "TASK:",
    task,
  ].join("\n");
}

async function executeJob(job, session) {
  const granted = await acquireSlot(job);
  if (!granted || job.status === "cancelled") {
    releaseSlot(job);
    return;
  }

  job.status = "running";
  job.lastActivityMs = Date.now();

  writeSessionEvent(session, {
    type: "turn_start",
    job_id: job.jobId,
    prompt: job.prompt,
  });
  launchSessionViewer(session);

  try {
    // Claude Code stream-json sessions only emit 'system/init' after the first
    // user message arrives, so the turn prompt is written immediately after
    // spawn and liveness is confirmed via the first stdout event.
    const userPromptContent = session.permissionMode === "yolo" ? wrapAutonomousPrompt(job.prompt) : job.prompt;
    const userEvent = {
      type: "user",
      message: {
        role: "user",
        content: userPromptContent,
      },
    };
    const userEventLine = `${JSON.stringify(userEvent)}\n`;

    const MAX_START_ATTEMPTS = 3;
    let started = false;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      if (job.status === "cancelling" || job.status === "cancelled") {
        return;
      }
      let releaseSpawn = null;
      try {
        if (!session.process || session.processExited) {
          releaseSpawn = await acquireSpawnSlot();
          spawnClaudeProcess(session);
        }

        session.process.stdin.write(userEventLine);
        logEvent(`job ${job.jobId} sent turn prompt to claude stdin (attempt ${attempt}/${MAX_START_ATTEMPTS})`);

        // Bounded liveness wait: reject on early exit, resolve on first event
        // or after 15s (silent-but-alive processes fall through to the idle
        // monitors below).
        await waitForFirstStreamEvent(session, 15_000);
        started = true;
        break;
      } catch (startErr) {
        logEvent(`job ${job.jobId} process startup attempt ${attempt} failed: ${startErr.message}`);
        await terminateSessionProcess(session, `startup retry cleanup`);
        if (attempt < MAX_START_ATTEMPTS) {
          await sleep(1200 * attempt);
        } else {
          throw startErr;
        }
      } finally {
        if (releaseSpawn) {
          releaseSpawn();
          releaseSpawn = null;
        }
      }
    }
    if (!started) return;

    const timeoutMs = (job.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES) * 60_000;
    const hardDeadline = Date.now() + Math.min(timeoutMs, TASK_HARD_TIMEOUT_MS);
    while (!TERMINAL_STATUSES.has(job.status)) {
      await sleep(1000);

      if (Date.now() > hardDeadline) {
        throw new Error(`Task exceeded timeout limit (${job.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES}m)`);
      }

      const silenceMs = Date.now() - job.lastActivityMs;
      const isToolStep = job?.progress?.step_type === "tool";
      const idleTimeoutMs = isToolStep ? TASK_TOOL_IDLE_TIMEOUT_MS : TASK_IDLE_TIMEOUT_MS;
      if (silenceMs > idleTimeoutMs) {
        const lastProgress = job.progress
          ? JSON.stringify({ step_index: job.progress.step_index, step_type: job.progress.step_type, state: job.progress.state })
          : "none";
        const reason = isToolStep ? "tool_silence_timeout" : "agent_idle_timeout";
        const error = new Error(
          `claude CLI stalled: ${reason} after ${Math.round(silenceMs / 1000)}s ` +
          `(limit ${Math.round(idleTimeoutMs / 60_000)}m, last_progress=${lastProgress})`,
        );
        error.code = reason;
        throw error;
      }
    }
  } catch (error) {
    if (job.status !== "cancelled") {
      job.status = "failed";
      job.stderr = safeTail(`${job.stderr}\n${error.stack || error.message}`);
    }
    settleJob(job);
    // Proactively kill the claude process so it cannot continue mutating workspace in background
    await terminateSessionProcess(session, `job execution aborted: ${error.message}`);
  }
}

async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`unknown job_id: ${jobId}`);
  if (TERMINAL_STATUSES.has(job.status)) return publicJob(job);

  if (job.status === "queued") {
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    dropSlotWaiter(job);
    settleJob(job);
    return publicJob(job);
  }

  job.status = "cancelling";
  job.cancelRequested = true;

  const session = sessions.get(job.sessionId);
  if (session) {
    await terminateSessionProcess(session, `job ${jobId} cancelled`);
  }

  job.status = "cancelled";
  settleJob(job);
  return publicJob(job);
}

function publicJob(job, includeOutput = true) {
  const result = {
    job_id: job.jobId,
    session_id: job.sessionId,
    claude_session_id: job.claudeSessionId || null,
    status: job.status,
    model: job.resolvedModel || job.model || "(configured default)",
    workspace: job.workspace,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    exit_code: job.exitCode,
  };

  if (includeOutput) {
    result.output = redactSensitive(job.response || job.stdout.trim());
    result.diagnostics = redactSensitive(job.stderr.trim());
    if (job.usage) {
      result.usage = job.usage;
    }
    if (typeof job.costUsd === "number") {
      result.cost_usd = job.costUsd;
    }
    if (typeof job.numTurns === "number") {
      result.num_turns = job.numTurns;
    }
    if (job.progress) {
      result.progress = {
        ...job.progress,
        last_activity_age_s: Math.max(0, Math.round((Date.now() - job.lastActivityMs) / 1000)),
      };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// TCP Dispatcher & Server

async function dispatch(method, params) {
  switch (method) {
    case "health":
      return {
        ...SERVER,
        active_jobs: hasActiveJobs(),
        parallel_limit: MAX_PARALLEL_JOBS,
        sessions_count: sessions.size,
        port: BROKER_PORT,
        user: os.userInfo().username,
        pid: process.pid,
        claude_exe: CLAUDE_EXE,
        models_count: cachedModels ? cachedModels.length : 0,
        models_status: lastModelQueryDiagnostic,
        models_source: lastSuccessfulSource,
        models_cache_file: MODELS_CACHE_FILE,
      };

    case "list_models":
      return await getAvailableModelFamilies(params);

    case "run_task":
      return await startJob(params, false);

    case "continue_task":
      return await startJob(params, true);

    case "get_status": {
      const job = jobs.get(params.job_id);
      if (!job) throw new Error(`unknown job_id: ${params.job_id}`);

      const waitMs = Math.min(Number(params.wait_ms) || 0, 45_000);
      if (waitMs > 0 && !TERMINAL_STATUSES.has(job.status)) {
        const fingerprint = () => `${job.status}|${job.claudeSessionId || ""}|${job.stdout.length}|${job.stderr.length}|${job.progress?.step_index || ""}`;
        const initial = fingerprint();
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && !TERMINAL_STATUSES.has(job.status) && fingerprint() === initial) {
          await sleep(400);
        }
      }
      return publicJob(job);
    }

    case "cancel_task":
      return cancelJob(params.job_id);

    default:
      throw new Error(`unknown broker method: ${method}`);
  }
}

function writeMessage(socket, message) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

async function handleLine(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeMessage(socket, { id: null, error: { message: `invalid JSON line: ${error.message}` } });
    return;
  }
  const id = request?.id ?? null;
  try {
    const result = await dispatch(request?.method, request?.params || {});
    writeMessage(socket, { id, result });
  } catch (error) {
    writeMessage(socket, { id, error: { message: redactSensitive(error.message) } });
  }
}

let server = null;

if (require.main === module) {
  assertHostUserSecurity();

  server = net.createServer((socket) => {
    clients.add(socket);
    lastActivity = Date.now();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) void handleLine(socket, line);
      }
    });

    socket.on("error", () => { /* client dropped */ });
    socket.on("close", () => {
      clients.delete(socket);
      lastActivity = Date.now();
    });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.exit(0);
    }
    process.stderr.write(`claudecode-broker server error: ${error.stack || error.message}\n`);
    process.exit(1);
  });

  server.listen(BROKER_PORT, "127.0.0.1", () => {
    process.stderr.write(`claudecode-broker listening on 127.0.0.1:${BROKER_PORT} (max parallel jobs: ${MAX_PARALLEL_JOBS}, claude: ${CLAUDE_EXE})\n`);
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (TERMINAL_STATUSES.has(job.status) && job.completedAt && now - Date.parse(job.completedAt) > JOB_TTL_MS) {
        jobs.delete(id);
      }
    }

    for (const [id, session] of sessions) {
      if (!session.activeJobId && session.processExited && now - Date.parse(session.lastUsedAt) > JOB_TTL_MS) {
        sessions.delete(id);
      }
    }

    if (IDLE_EXIT_MS > 0 && clients.size === 0 && !hasActiveJobs() && now - lastActivity > IDLE_EXIT_MS) {
      logEvent("claudecode-broker idle timeout reached, triggering graceful shutdown");
      void shutdownBroker("idle timeout");
    }
  }, 30_000).unref();

  process.on("SIGINT", () => { void shutdownBroker("SIGINT"); });
  process.on("SIGTERM", () => { void shutdownBroker("SIGTERM"); });

  process.on("exit", () => {
    for (const session of sessions.values()) {
      if (session.process && !session.processExited && session.process.pid) {
        try {
          if (process.platform === "win32") {
            const { execFileSync } = require("node:child_process");
            execFileSync("taskkill", ["/pid", String(session.process.pid), "/T", "/F"], { stdio: "ignore" });
          } else {
            process.kill(session.process.pid, "SIGKILL");
          }
        } catch { /* ignore */ }
      }
    }
  });

  process.on("uncaughtException", (error) => {
    process.stderr.write(`claudecode-broker uncaught exception: ${error.stack || error.message}\n`);
  });

  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`claudecode-broker unhandled rejection: ${reason?.stack || reason}\n`);
  });
}

let isShuttingDown = false;
async function shutdownBroker(reason = "idle timeout") {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logEvent(`initiating graceful broker shutdown (${reason})...`);

  try {
    if (server) server.close();
  } catch { /* ignore */ }

  const terminations = [];
  for (const session of sessions.values()) {
    if (session.process && !session.processExited) {
      terminations.push(terminateSessionProcess(session, `broker shutdown (${reason})`));
    }
  }

  try {
    await Promise.allSettled(terminations);
    logEvent("all persistent claude sessions terminated cleanly");
  } catch (err) {
    logEvent(`error during shutdown termination: ${err?.message || err}`);
  }

  process.exit(0);
}

module.exports = {
  SERVER,
  BROKER_PORT,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_MODEL_FAMILIES,
  KNOWN_MODEL_ALIASES,
  MODELS_CACHE_FILE,
  MODELS_CACHE_DIR,
  getClaudeEnv,
  getGatewayConfig,
  categorizeGatewayError,
  getBaseFamilyName,
  getEffortScore,
  makeWorkerName,
  loadPersistentCache,
  savePersistentCache,
  fetchGatewayModelsOnce,
  fetchGatewayModelsWithRetry,
  fetchDynamicModelsSingleton,
  getAvailableModelFamilies,
  resolveModelSelection,
  formatModelResponse,
  buildClaudeArgs,
  dispatch,
  assertHostUserSecurity,
  validateRawModels,
  validateFamilyQuality,
};
