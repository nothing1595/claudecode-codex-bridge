#!/usr/bin/env node
"use strict";

// Unit & Integration Tests for Model Discovery, Caching, and Fast-Path
// Verifies:
// 1. Successful gateway query caching to disk and memory
// 2. Query failure preserving last complete model list with stale/diagnostics marking
// 3. Built-in fallback catalog availability
// 4. Concurrent requests singleflight (singleton execution, one HTTP hit)
// 5. Known model aliases resolving via fast-path without hitting the gateway
// 6. Accurate failure reason categorization (timeout, auth, unreachable)
//
// A local fixture HTTP server plays the role of the Anthropic-compatible gateway.

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");

// Environment must be injected BEFORE requiring the broker module (cache file
// path is resolved at require time).
const tmpDir = path.join(os.tmpdir(), `ccb-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testCacheFile = path.join(tmpDir, "test-models-cache.json");
process.env.CCB_MODELS_CACHE_FILE = testCacheFile;
process.env.CCB_MODELS_CACHE_TTL_MS = "0"; // always bypass TTL so each call exercises the real query path

const broker = require("../server/claudecode-broker.cjs");

const FIXTURE_MODELS = {
  data: [
    { id: "fable-test-high", display_name: "Fable Test (High)", owned_by: "test" },
    { id: "fable-test-low", display_name: "Fable Test (Low)", owned_by: "test" },
    { id: "gpt-5.6-luna", display_name: "GPT 5.6 Luna", owned_by: "openai" },
    { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6 (Thinking)", owned_by: "antigravity" },
  ],
};

function startFixtureServer() {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    if (req.url.includes("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FIXTURE_MODELS));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, getRequestCount: () => requestCount });
    });
  });
}

async function runTests() {
  console.log("=== Testing Gateway Model Discovery, Caching & Singleflight ===");

  // -------------------------------------------------------------------------
  // Test 1: Persistent Cache Save & Load
  // -------------------------------------------------------------------------
  console.log("\n[Test 1] Persistent cache save and load...");
  const sampleModels = [
    {
      worker_name: "cc_sonnet_worker",
      model_family: "Sonnet",
      target_model: "sonnet",
      description: "Claude Sonnet (alias)",
      effort: null,
    },
    {
      worker_name: "cc_opus_worker",
      model_family: "Opus",
      target_model: "opus",
      description: "Claude Opus (alias)",
      effort: null,
    },
  ];

  const saved = broker.savePersistentCache(sampleModels, 2, testCacheFile);
  assert.strictEqual(saved, true, "savePersistentCache should return true");
  assert.strictEqual(fs.existsSync(testCacheFile), true, "Cache file should exist on disk");

  const loaded = broker.loadPersistentCache(testCacheFile);
  assert.ok(loaded, "loadPersistentCache should return data");
  assert.strictEqual(loaded.model_families.length, 2, "Loaded families count should match");
  assert.strictEqual(loaded.source, "gateway_models_api");
  assert.strictEqual(loaded.model_families[0].worker_name, "cc_sonnet_worker");
  assert.ok(loaded.timestamp > 0, "Timestamp should be valid");
  console.log("✓ Persistent cache save/load passed");

  // -------------------------------------------------------------------------
  // Test 2: Dynamic discovery via fixture gateway + family aggregation
  // -------------------------------------------------------------------------
  console.log("\n[Test 2] Dynamic discovery via fixture gateway...");
  const fixture = await startFixtureServer();
  process.env.CCB_GATEWAY_BASE_URL = fixture.url;
  process.env.CCB_GATEWAY_AUTH_TOKEN = "test-token";

  const families = await broker.getAvailableModelFamilies({ force: true, detailed: true });
  assert.strictEqual(families.stale, false, "Fresh discovery should not be stale");
  assert.strictEqual(families.source, "gateway_models_api");
  assert.ok(families.count >= 3, `Expected >= 3 families, got ${families.count}`);

  const fableFamily = families.models.find((f) => f.model_family === "Fable Test");
  assert.ok(fableFamily, "Fable Test family should exist");
  assert.strictEqual(fableFamily.target_model, "fable-test-high", "Family should pick highest-effort variant");
  assert.strictEqual(fableFamily.worker_name, "cc_fabletest_worker");

  const lunaFamily = families.models.find((f) => f.model_family === "GPT 5.6 Luna");
  assert.ok(lunaFamily, "GPT 5.6 Luna family should exist");
  assert.strictEqual(lunaFamily.target_model, "gpt-5.6-luna");
  console.log(`✓ Dynamic discovery passed (${families.count} families, highest-effort selection verified)`);

  // -------------------------------------------------------------------------
  // Test 3: Singleflight — concurrent discovery triggers exactly one HTTP query
  // -------------------------------------------------------------------------
  console.log("\n[Test 3] Singleflight concurrency...");
  const before = fixture.getRequestCount();
  await Promise.all([
    broker.fetchDynamicModelsSingleton(),
    broker.fetchDynamicModelsSingleton(),
    broker.fetchDynamicModelsSingleton(),
  ]);
  await broker.fetchDynamicModelsSingleton(); // sequential call re-queries (in-flight promise already cleared)
  const queries = fixture.getRequestCount() - before;
  assert.strictEqual(queries, 2, `Expected exactly 2 gateway queries (1 singleflight batch + 1 sequential), got ${queries}`);
  console.log("✓ Singleflight passed (3 concurrent calls -> 1 query)");

  // -------------------------------------------------------------------------
  // Test 4: Failure path serves stale cache with diagnostics (non-destructive)
  // -------------------------------------------------------------------------
  console.log("\n[Test 4] Gateway failure serves stale cache...");
  process.env.CCB_GATEWAY_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
  const stale = await broker.getAvailableModelFamilies({ force: true, detailed: true });
  assert.strictEqual(stale.stale, true, "Failed refresh should be flagged stale");
  assert.strictEqual(stale.count, families.count, "Stale response should preserve full previous list");
  assert.ok(stale.diagnostics && stale.diagnostics.includes("gateway_unreachable"), `Diagnostics should mention reason, got: ${stale.diagnostics}`);
  console.log("✓ Non-destructive stale degradation passed");

  // -------------------------------------------------------------------------
  // Test 5: Built-in fallback catalog shape
  // -------------------------------------------------------------------------
  console.log("\n[Test 5] Built-in fallback catalog...");
  assert.ok(broker.DEFAULT_MODEL_FAMILIES.length >= 4, "Built-in catalog should include sonnet/opus/haiku/fable");
  assert.ok(broker.DEFAULT_MODEL_FAMILIES.every((f) => f.worker_name && f.target_model && f.model_family));
  console.log(`✓ Built-in fallback catalog passed (${broker.DEFAULT_MODEL_FAMILIES.length} aliases)`);

  // -------------------------------------------------------------------------
  // Test 6: Fast-path alias resolution (dead gateway proves no query needed)
  // -------------------------------------------------------------------------
  console.log("\n[Test 6] Fast-path alias resolution...");
  const sonnet = await broker.resolveModelSelection("cc_sonnet_worker");
  assert.deepStrictEqual({ model: sonnet.model, effort: sonnet.effort }, { model: "sonnet", effort: null });

  const omitted = await broker.resolveModelSelection(undefined);
  assert.strictEqual(omitted.model, null, "No model requested must resolve to null (omit --model)");

  const explicitDefault = await broker.resolveModelSelection("default");
  assert.strictEqual(explicitDefault.model, null, "'default' alias must resolve to null model");

  const passthrough = await broker.resolveModelSelection("my-custom-gateway-slug");
  assert.strictEqual(passthrough.model, "my-custom-gateway-slug", "Unknown slugs pass through verbatim");

  const fromCache = await broker.resolveModelSelection("cc_gpt5.6luna_worker");
  assert.strictEqual(fromCache.model, "gpt-5.6-luna", "Worker alias should resolve via discovered families");
  console.log("✓ Fast-path alias resolution passed");

  // -------------------------------------------------------------------------
  // Test 7: Error categorization
  // -------------------------------------------------------------------------
  console.log("\n[Test 7] Gateway error categorization...");
  const timeoutCat = broker.categorizeGatewayError(Object.assign(new Error("Gateway query timed out after 5ms"), { code: "ECONNABORTED" }));
  assert.strictEqual(timeoutCat.reason, "timeout");

  const authCat = broker.categorizeGatewayError({ statusCode: 401, message: "HTTP 401" });
  assert.strictEqual(authCat.reason, "auth_permission");

  const rateCat = broker.categorizeGatewayError({ statusCode: 429, message: "HTTP 429" });
  assert.strictEqual(rateCat.reason, "rate_limited");

  const refusedCat = broker.categorizeGatewayError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }));
  assert.strictEqual(refusedCat.reason, "gateway_unreachable");
  console.log("✓ Error categorization passed");

  // -------------------------------------------------------------------------
  // Test 8: CPA-only fail-closed enforcement
  // -------------------------------------------------------------------------
  console.log("\n[Test 8] CPA-only fail-closed enforcement...");
  const savedApiKey = process.env.ANTHROPIC_API_KEY;

  // 8a. Off-allowlist gateway (api.anthropic.com) must be refused
  process.env.CCB_GATEWAY_BASE_URL = "https://api.anthropic.com";
  process.env.CCB_GATEWAY_AUTH_TOKEN = "official-key";
  assert.throws(() => broker.assertGatewayAllowed("https://api.anthropic.com"), /not in the CPA allowlist/, "Official API endpoint must be rejected by allowlist");
  assert.throws(() => broker.getRequiredClaudeExecutionEnv(), /allowlist/, "Execution env must refuse off-allowlist gateway");
  await assert.rejects(() => broker.assertExecutionGateway(), /allowlist/, "run_task preflight must refuse off-allowlist gateway");

  // For the remaining sub-tests, extend the allowlist with the fixture/dead
  // loopback endpoints (8a already proved the default allowlist rejects
  // non-local URLs).
  const savedAllowlist = process.env.CCB_ALLOWED_GATEWAY_URLS;
  process.env.CCB_ALLOWED_GATEWAY_URLS = `http://127.0.0.1:8317,http://localhost:8317,http://127.0.0.1:1,${fixture.url}`;

  // 8b. Allowlisted but unreachable gateway must fail preflight
  process.env.CCB_GATEWAY_BASE_URL = "http://127.0.0.1:1";
  const unreachableHealth = await broker.checkGatewayHealth();
  assert.strictEqual(unreachableHealth.status, "gateway_unreachable", `Dead gateway should report unreachable, got ${unreachableHealth.status}`);
  await assert.rejects(
    () => broker.assertExecutionGateway(),
    /CPA gateway preflight failed|Conflicting gateway configuration/,
    "run_task preflight must refuse an unreachable gateway (or the conflicting settings override)",
  );

  // 8c. Env override precedence: CCB_* env wins over settings.json / process env
  //     (the missing-credentials guard cannot be exercised on a machine whose
  //     ~/.claude/settings.json supplies a real CPA token, so precedence is
  //     the observable contract here)
  process.env.CCB_GATEWAY_BASE_URL = fixture.url;
  process.env.CCB_GATEWAY_AUTH_TOKEN = "test-token";
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  process.env.ANTHROPIC_AUTH_TOKEN = "ambient-official-token";
  const resolvedConfig = broker.getGatewayConfig();
  assert.strictEqual(resolvedConfig.baseUrl, fixture.url, "CCB_GATEWAY_BASE_URL must take precedence over everything");
  assert.strictEqual(resolvedConfig.token, "test-token", "CCB_GATEWAY_AUTH_TOKEN must take precedence over everything");
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  // 8d. Healthy allowlisted gateway: env injection + official key stripping
  process.env.CCB_GATEWAY_BASE_URL = fixture.url; // 127.0.0.1 is on the default allowlist
  process.env.CCB_GATEWAY_AUTH_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "ambient-official-key";
  const execEnv = broker.getRequiredClaudeExecutionEnv();
  assert.strictEqual(execEnv.ANTHROPIC_BASE_URL, fixture.url, "Execution env must inject the CPA base URL");
  assert.strictEqual(execEnv.ANTHROPIC_AUTH_TOKEN, "test-token", "Execution env must inject the CPA token");
  assert.strictEqual(execEnv.ANTHROPIC_API_KEY, undefined, "Ambient official API key must be stripped");

  const healthy = await broker.checkGatewayHealth({ baseUrl: fixture.url, token: "test-token" });
  assert.strictEqual(healthy.status, "ok", `Fixture gateway should be healthy, got ${healthy.status}`);

  // Conflict guard: when ~/.claude/settings.json pins a different base URL,
  // an env override must fail closed (Claude Code would re-apply its own
  // settings over our injection, so the divergence is unprovable-safe).
  const hostProfile = process.env.CCB_USER_PROFILE
    || (fs.existsSync("C:\\Users\\15869") ? "C:\\Users\\15869" : os.homedir());
  const realSettingsPath = path.join(hostProfile, ".claude", "settings.json");
  let settingsBaseUrl = null;
  try {
    if (fs.existsSync(realSettingsPath)) {
      settingsBaseUrl = JSON.parse(fs.readFileSync(realSettingsPath, "utf8")).env?.ANTHROPIC_BASE_URL || null;
    }
  } catch { /* treat as absent */ }
  if (settingsBaseUrl && settingsBaseUrl.replace(/\/+$/, "").toLowerCase() !== fixture.url) {
    await assert.rejects(
      () => broker.assertExecutionGateway(),
      /Conflicting gateway configuration/,
      "Env override diverging from settings.json must fail closed",
    );
  } else {
    await broker.assertExecutionGateway(); // no conflicting settings -> fixture is authoritative
  }
  console.log("✓ CPA-only fail-closed passed (allowlist / unreachable / precedence / env injection / conflict guard)");

  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedAllowlist === undefined) delete process.env.CCB_ALLOWED_GATEWAY_URLS;
  else process.env.CCB_ALLOWED_GATEWAY_URLS = savedAllowlist;

  // -------------------------------------------------------------------------
  // Test 9: 429 rate-limit circuit breaker state machine
  // -------------------------------------------------------------------------
  console.log("\n[Test 9] 429 circuit breaker...");
  // start from a clean slate
  broker.noteSettlementForRateLimit({ status: "completed" });
  assert.strictEqual(broker.getRateLimitBreakerState().streak, 0, "Streak should start at 0");

  // detection: api_retry flag and result-text matching both count as 429
  assert.strictEqual(broker.isRateLimitFailure({ sawRateLimit: true }), true, "sawRateLimit flag must be detected");
  assert.strictEqual(
    broker.isRateLimitFailure({ stderr: "", response: "API Error: Request rejected (429) · Resource has been exhausted" }),
    true,
    "429 result text must be detected",
  );
  assert.strictEqual(
    broker.isRateLimitFailure({ stderr: "claude CLI closed with code 1" }),
    false,
    "non-quota failures must not be detected as rate-limit",
  );

  // one 429 failure: streak 1, breaker still closed, dispatch allowed
  broker.noteSettlementForRateLimit({ status: "failed", sawRateLimit: true });
  let breaker = broker.getRateLimitBreakerState();
  assert.strictEqual(breaker.streak, 1);
  assert.strictEqual(breaker.open, false, "Breaker must stay closed below threshold (2)");
  broker.assertRateLimitBreaker(); // must not throw

  // non-quota failure does not advance the streak
  broker.noteSettlementForRateLimit({ status: "failed", stderr: "spawn ENOENT" });
  assert.strictEqual(broker.getRateLimitBreakerState().streak, 1, "Non-quota failure must not count");

  // cancelled jobs neither count nor reset
  broker.noteSettlementForRateLimit({ status: "cancelled" });
  assert.strictEqual(broker.getRateLimitBreakerState().streak, 1, "Cancelled job must not change the streak");

  // second 429 failure: breaker opens, dispatch refused
  broker.noteSettlementForRateLimit({ status: "failed", response: "usage limit has been reached" });
  breaker = broker.getRateLimitBreakerState();
  assert.strictEqual(breaker.open, true, "Breaker must open at threshold");
  assert.ok(breaker.cooldown_remaining_s > 0, "Cooldown must be positive");
  await assert.rejects(async () => broker.assertRateLimitBreaker(), /circuit breaker is OPEN/, "Dispatch must be refused while open");

  // a completed job fully resets (closes) the breaker
  broker.noteSettlementForRateLimit({ status: "completed" });
  breaker = broker.getRateLimitBreakerState();
  assert.strictEqual(breaker.open, false, "Completed job must close the breaker");
  assert.strictEqual(breaker.streak, 0);
  broker.assertRateLimitBreaker(); // must not throw again
  console.log("✓ 429 circuit breaker passed (threshold / non-quota / cancelled / open / reset)");

  // Cleanup
  delete process.env.CCB_GATEWAY_BASE_URL;
  delete process.env.CCB_GATEWAY_AUTH_TOKEN;
  await new Promise((resolve) => fixture.server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("\n=== All model discovery tests passed! ===");
}

runTests().catch((err) => {
  console.error("Model discovery tests failed:", err);
  process.exit(1);
});
