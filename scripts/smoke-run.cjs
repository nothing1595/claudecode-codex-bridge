#!/usr/bin/env node
"use strict";

// Smoke test for single-worker dynamic model discovery, alias resolution,
// and multi-turn session continuation via TCP broker

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BROKER_PORT = Number(process.env.CCB_BROKER_PORT || 19226);
const BROKER_PATH = path.join(__dirname, "..", "server", "claudecode-broker.cjs");

const workspace = path.resolve(process.argv[2] || ".");
const testModel = process.argv[3] || undefined; // omit -> user-configured default

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function brokerRequest(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(BROKER_PORT, "127.0.0.1");
    let buffer = "";
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        socket.end();
        try {
          const res = JSON.parse(buffer.slice(0, nl));
          if (res.error) reject(new Error(res.error.message));
          else resolve(res.result);
        } catch (e) {
          reject(e);
        }
      }
    });
  });
}

async function ensureBroker() {
  for (let i = 0; i < 25; i++) {
    try {
      await brokerRequest("health", {});
      return;
    } catch {
      if (i === 0) {
        console.log("Starting detached claudecode-broker daemon...");
        let launched = false;
        if (process.platform === "win32") {
          try {
            const { execFileSync } = require("node:child_process");
            execFileSync("schtasks", ["/Run", "/TN", "ClaudeCodeBroker"], { stdio: "ignore", timeout: 5000 });
            launched = true;
          } catch { /* fallback */ }
        }
        if (!launched) {
          const child = spawn(process.execPath, [BROKER_PATH], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.unref();
        }
      }
      await sleep(300);
    }
  }
  throw new Error("Unable to reach claudecode-broker daemon");
}

async function pollUntilFinished(jobId) {
  console.log(`Polling job ${jobId}...`);
  for (let i = 0; i < 60; i++) {
    const status = await brokerRequest("get_status", { job_id: jobId, wait_ms: 10000 });
    console.log(`[Status: ${status.status}] progress:`, status.progress || "(none)");
    if (["completed", "failed", "cancelled"].includes(status.status)) {
      return status;
    }
  }
  throw new Error(`Job ${jobId} timed out`);
}

async function main() {
  await ensureBroker();
  console.log(`Broker healthy on 127.0.0.1:${BROKER_PORT}`);

  // Test 1: list_models
  console.log("\n=== Test 1: list_models dynamic discovery ===");
  const models = await brokerRequest("list_models", {});
  console.log(`Discovered ${models.length} model families:`);
  for (const m of models) {
    console.log(`  • ${m.worker_name.padEnd(30)} -> ${m.target_model} (${m.description}) [source: ${m.source}${m.stale ? ", stale" : ""}]`);
  }
  if (models.length === 0) {
    throw new Error("list_models returned no families");
  }

  // Test 2: run_task (default model unless one is given)
  console.log(`\n=== Test 2: run_task (model: ${testModel || "user-configured default"}) ===`);
  const task1 = "Reply with exactly: 'CC_BRIDGE_OK_777' and nothing else.";
  const job1 = await brokerRequest("run_task", {
    workspace,
    task: task1,
    ...(testModel ? { model: testModel } : {}),
    permission_mode: "yolo",
  });
  console.log("Job 1 started:", job1);

  const res1 = await pollUntilFinished(job1.job_id);
  console.log("\n--- Turn 1 Result ---");
  console.log("Status:", res1.status);
  console.log("Model :", res1.model);
  console.log("Output:", res1.output);
  console.log("Usage :", res1.usage);

  if (res1.status !== "completed") {
    throw new Error(`Turn 1 failed: ${res1.diagnostics}`);
  }

  if (!res1.output || !res1.output.includes("CC_BRIDGE_OK_777")) {
    throw new Error(`Turn 1 token assertion failed: expected output to include 'CC_BRIDGE_OK_777', but got: ${res1.output}`);
  }
  console.log("Turn 1 token assertion verified: 'CC_BRIDGE_OK_777' present.");

  // Test 3: continue_task using same session
  console.log(`\n=== Test 3: continue_task in session ${res1.session_id} ===`);
  const task2 = "Repeat the exact token you sent in the previous turn.";
  const job2 = await brokerRequest("continue_task", {
    session_id: res1.session_id,
    task: task2,
  });
  console.log("Job 2 started:", job2);

  const res2 = await pollUntilFinished(job2.job_id);
  console.log("\n--- Turn 2 Result ---");
  console.log("Status:", res2.status);
  console.log("Output:", res2.output);
  console.log("Usage :", res2.usage);

  if (res2.status !== "completed") {
    throw new Error(`Turn 2 failed: ${res2.diagnostics}`);
  }

  if (!res2.output || !res2.output.includes("CC_BRIDGE_OK_777")) {
    throw new Error(`Turn 2 continuity token assertion failed: expected follow-up output to remember 'CC_BRIDGE_OK_777', but got: ${res2.output}`);
  }
  console.log("Turn 2 continuity token assertion verified: remembered 'CC_BRIDGE_OK_777'.");

  console.log("\n=== Single unified worker smoke test passed successfully! ===");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
