#!/usr/bin/env node
"use strict";

// Parallelism and cancellation smoke test for ClaudeCode-Codex Bridge

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BROKER_PORT = Number(process.env.CCB_BROKER_PORT || 19226);
const BROKER_PATH = path.join(__dirname, "..", "server", "claudecode-broker.cjs");

const workspace = path.resolve(process.argv[2] || ".");
const model = process.argv[3] || undefined; // omit -> user-configured default
const isCancelTest = process.argv.includes("--cancel");

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

async function runCancelTest() {
  console.log("\n=== Testing Graceful Task Cancellation ===");
  const job = await brokerRequest("run_task", {
    workspace,
    task: "Count from 1 to 100 with a 1 second delay between each number.",
    ...(model ? { model } : {}),
  });
  console.log("Started job for cancellation:", job.job_id);

  // Let it spin up and enter running
  await sleep(2000);
  const statusBefore = await brokerRequest("get_status", { job_id: job.job_id });
  console.log("Status before cancel:", statusBefore.status);

  console.log("Requesting cancellation...");
  const cancelRes = await brokerRequest("cancel_task", { job_id: job.job_id });
  console.log("Cancel call returned:", cancelRes);

  // Wait for settlement
  for (let i = 0; i < 15; i++) {
    const s = await brokerRequest("get_status", { job_id: job.job_id });
    console.log(`[Check ${i + 1}] status = ${s.status}`);
    if (s.status === "cancelled") {
      console.log("Job successfully cancelled!");
      return;
    }
    await sleep(500);
  }
  throw new Error("Job did not settle into cancelled state in time");
}

async function runParallelTest() {
  console.log("\n=== Testing Parallel Execution (2 concurrent jobs) ===");
  const t1 = "Explain in three numbered points what a singleton pattern is, and end your reply with RESULT_T1_OK.";
  const t2 = "Explain in three numbered points what a semaphore pattern is, and end your reply with RESULT_T2_OK.";

  const [job1, job2] = await Promise.all([
    brokerRequest("run_task", { workspace, task: t1, ...(model ? { model } : {}) }),
    brokerRequest("run_task", { workspace, task: t2, ...(model ? { model } : {}) }),
  ]);

  console.log("Submitted job 1:", job1.job_id);
  console.log("Submitted job 2:", job2.job_id);

  let observedOverlap = false;

  async function poll(jobId) {
    for (let i = 0; i < 60; i++) {
      const s = await brokerRequest("get_status", { job_id: jobId, wait_ms: 5000 });
      if (["completed", "failed", "cancelled"].includes(s.status)) {
        return s;
      }
    }
    // Smoke runner observation window exhausted, not a broker task timeout.
    throw new Error(`Smoke-test observation window exhausted; broker job ${jobId} may still be active — query get_status directly or raise the observation budget.`);
  }

  // Periodic overlap checker
  const overlapInterval = setInterval(async () => {
    try {
      const [s1, s2] = await Promise.all([
        brokerRequest("get_status", { job_id: job1.job_id }),
        brokerRequest("get_status", { job_id: job2.job_id }),
      ]);
      if (s1.status === "running" && s2.status === "running") {
        if (!observedOverlap) {
          console.log(">>> [CONCURRENCY VERIFIED] Concurrent running overlap observed between Job 1 and Job 2!");
        }
        observedOverlap = true;
      }
    } catch { /* ignore */ }
  }, 150);

  const [res1, res2] = await Promise.all([poll(job1.job_id), poll(job2.job_id)]);
  clearInterval(overlapInterval);

  console.log("Job 1 finished with:", res1.status, `output: ${res1.output}`);
  console.log("Job 2 finished with:", res2.status, `output: ${res2.output}`);
  console.log("Observed concurrent running overlap:", observedOverlap);

  if (!observedOverlap) {
    throw new Error("Parallel test failed: no overlapping running interval observed (jobs did not execute concurrently)");
  }

  if (res1.status !== "completed" || res2.status !== "completed") {
    throw new Error("One or more parallel jobs failed");
  }

  console.log("\n=== Parallel test passed successfully! ===");
}

// Pre-dispatch guard: refuse to burn quota when the gateway is rate-limited
// or the broker's 429 circuit breaker is open.
async function assertGatewayDispatchable() {
  const h = await brokerRequest("health", {});
  const breaker = h.rate_limit_breaker;
  if (breaker && breaker.open) {
    console.warn(`TEST SKIPPED: broker 429 circuit breaker is OPEN (streak ${breaker.streak}/${breaker.threshold}, cooldown ${Math.ceil(breaker.cooldown_remaining_s / 60)}m remaining).`);
    process.exit(2);
  }
  const gh = h.gateway_health;
  if (gh && gh.status === "rate_limited") {
    console.warn("TEST SKIPPED: CPA gateway is currently rate-limited (HTTP 429 on /v1/models).");
    process.exit(2);
  }
}

async function main() {
  await ensureBroker();
  await assertGatewayDispatchable();
  if (isCancelTest) {
    await runCancelTest();
  } else {
    await runParallelTest();
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
