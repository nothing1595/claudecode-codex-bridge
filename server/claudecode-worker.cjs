#!/usr/bin/env node
"use strict";

// Thin MCP wrapper: speaks stdio JSON-RPC 2.0 to Codex and relays every tool
// call to the singleton claudecode-broker over loopback TCP (127.0.0.1:19226).
// Multiple Codex subagents — each with its own wrapper process — funnel into the
// broker, which manages persistent claude sessions and turn concurrency safely.
// If no broker is reachable, one is spawned detached and connection retries converge.

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = { name: "codex-claudecode-worker", version: "0.1.0" };
const BROKER_PATH = path.join(__dirname, "claudecode-broker.cjs");
const BROKER_PORT = Number(process.env.CCB_BROKER_PORT || 19226);
const BROKER_START_ATTEMPTS = 40;
const BROKER_START_RETRY_MS = 250;
const BROKER_REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    isError,
  };
}

function brokerRequest(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(BROKER_PORT, "127.0.0.1");
    let buffer = "";
    let settled = false;
    let requestSent = false;

    const fail = (error, wasSent = requestSent) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error.requestSent = wasSent;
      reject(error);
    };

    socket.setTimeout(BROKER_REQUEST_TIMEOUT_MS);
    socket.on("timeout", () => fail(Object.assign(new Error("broker request timed out"), { code: "ETIMEDOUT" }), true));
    socket.on("error", (err) => fail(err, requestSent));

    socket.on("connect", () => {
      requestSent = true;
      socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (settled) return;
      settled = true;
      socket.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.error) {
          const error = new Error(message.error.message || "broker error");
          error.code = "EBROKER_RPC";
          error.requestSent = requestSent;
          reject(error);
        } else {
          resolve(message.result);
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

function spawnBroker() {
  // 1. On Windows, attempt to launch via Scheduled Task "ClaudeCodeBroker".
  // This guarantees the broker process executes in the authenticated interactive host user session (e.g. 15869)
  // even when the Codex worker runs under a Windows sandbox user (codexsandboxoffline).
  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync("schtasks", ["/Run", "/TN", "ClaudeCodeBroker"], { stdio: "ignore", timeout: 5000 });
      return;
    } catch {
      // Scheduled task not available or error, fall back to direct spawn
    }
  }

  // 2. Direct spawn fallback (only safe if running in host user session)
  const os = require("node:os");
  const current = (os.userInfo().username || "").toLowerCase();
  if (current.includes("sandbox")) {
    // In sandbox: spawning directly will create an unauthenticated sandbox broker.
    // Rely exclusively on Scheduled Task or external host broker daemon.
    return;
  }

  const fs = require("node:fs");
  const hostProfile = process.env.CCB_USER_PROFILE || (fs.existsSync("C:\\Users\\15869") ? "C:\\Users\\15869" : os.homedir());
  const child = spawn(process.execPath, [BROKER_PATH], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      USERPROFILE: hostProfile,
      HOME: hostProfile,
      APPDATA: path.join(hostProfile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(hostProfile, "AppData", "Local"),
    },
  });
  child.unref();
}

const NON_IDEMPOTENT_METHODS = new Set(["run_task", "continue_task"]);

async function callBroker(method, params) {
  let lastError;
  for (let attempt = 0; attempt <= BROKER_START_ATTEMPTS; attempt += 1) {
    try {
      return await brokerRequest(method, params);
    } catch (error) {
      lastError = error;
      // If request was already sent to the broker, NEVER retry non-idempotent operations!
      if (error.requestSent && NON_IDEMPOTENT_METHODS.has(method)) {
        throw new Error(`claudecode-broker request failed after dispatch (${method}): ${error.message}`);
      }
      // A valid broker response containing an application error is not a
      // connectivity failure and must not be reported as "broker unreachable".
      if (error.code === "EBROKER_RPC") {
        throw error;
      }
      const connectFailure = ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error.code);
      if (!connectFailure || attempt === BROKER_START_ATTEMPTS) break;
      if (attempt === 0) spawnBroker();
      await sleep(BROKER_START_RETRY_MS);
    }
  }
  throw new Error(`claudecode-broker unreachable on 127.0.0.1:${BROKER_PORT}. Please ensure the host broker daemon is running in your interactive desktop session (run scripts\\start-broker.ps1 or 'schtasks /Run /TN ClaudeCodeBroker'). Details: ${lastError?.message || "unknown error"}`);
}

const tools = [
  {
    name: "list_models",
    description: "List all models available to Claude Code on this machine, discovered from the Anthropic-compatible gateway (/v1/models) and grouped by model family with 'cc_XXX_worker' naming. Falls back to the built-in sonnet/opus/haiku/fable alias catalog. Supports cached serving and diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        detailed: {
          type: "boolean",
          description: "Optional: when true, returns an object containing models, stale status, source, and failure diagnostics.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_task",
    description: "Start a new persistent Claude Code CLI session in the specified workspace. Returns immediately with job_id and session_id. Extra jobs queue when the parallel limit is reached; poll job_id with get_status. Accepts model aliases (sonnet/opus/haiku/fable, cc_XXX_worker) or gateway slugs; omit model to use the user-configured default.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Absolute path to the shared workspace directory.",
        },
        task: {
          type: "string",
          description: "Complete instruction or delegated task for Claude Code.",
        },
        model: {
          type: "string",
          description: "Model alias or gateway slug to use (e.g. sonnet, opus, claude-sonnet-4-6). Default: omit to use the user-configured default model.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description: "Optional reasoning effort override. Only forwarded when explicitly provided; gateway model slugs often encode effort themselves.",
        },
        agent: {
          type: "string",
          description: "Optional Claude Code agent name (--agent) for the session.",
        },
        permission_mode: {
          type: "string",
          enum: ["yolo", "safe"],
          default: "yolo",
          description: "Permission mode. 'yolo' passes --dangerously-skip-permissions to auto-approve tool execution. 'safe' uses --permission-mode acceptEdits (file edits auto-approved, anything that would prompt is denied).",
        },
        timeout_minutes: {
          type: "number",
          description: "Optional task timeout in minutes (default: 240 min / 4 hours, bounded by CCB_TASK_TIMEOUT_MS). Pass lower value to restrict specific short-lived tasks.",
          default: 240,
        },
      },
      required: ["workspace", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "continue_task",
    description: "Continue an existing Claude Code session with a follow-up instruction. Feeds the prompt into the running claude process stdin without restarting the CLI; if the process died, the session is lazily revived via --resume <claude_session_id>.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id returned from run_task.",
        },
        task: {
          type: "string",
          description: "Follow-up instruction for the ongoing session.",
        },
        timeout_minutes: {
          type: "number",
          description: "Optional turn timeout override in minutes for this continuation (default: session timeout, up to 4 hours).",
        },
      },
      required: ["session_id", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description: "Get status, progress, and output for a Claude Code job. Statuses: queued, running, completed, failed, cancelled. Supports server-side long polling via wait_ms (recommended: 40000) to avoid busy-polling.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job_id to check.",
        },
        wait_ms: {
          type: "number",
          description: "Hold response until status or progress changes, up to 45000 ms. Recommended: 40000.",
          default: 40000,
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_task",
    description: "Cancel an active or queued Claude Code task. Gracefully terminates the running turn or halts the subprocess tree.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job_id to cancel.",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (!["list_models", "run_task", "continue_task", "get_status", "cancel_task"].includes(name)) {
    return textResult(`unknown tool: ${name}`, true);
  }
  const result = await callBroker(name, args || {});
  return textResult(result);
}

async function handle(request) {
  if (!request || request.jsonrpc !== "2.0") return;
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;

  if (request.method === "initialize") {
    const protocolVersion = request.params?.protocolVersion || "2024-11-05";
    return send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER,
      },
    });
  }

  if (request.method === "ping") {
    return send({ jsonrpc: "2.0", id: request.id, result: {} });
  }

  if (request.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: request.id, result: { tools } });
  }

  if (request.method === "tools/call") {
    try {
      const result = await callTool(request.params?.name, request.params?.arguments || {});
      return send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      return send({ jsonrpc: "2.0", id: request.id, result: textResult(error.stack || error.message, true) });
    }
  }

  if (request.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`Invalid MCP message: ${error.message}\n`);
    }
  }
});
