#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const readline = require("node:readline");

const sessionId = process.argv[2] || "unknown_session";
const logPath = process.argv[3];

if (!logPath) {
  console.error("Usage: node claudecode-viewer.cjs <sessionId> <eventLogPath>");
  process.exit(1);
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  yellow: "\x1b[33m",
  brightYellow: "\x1b[93m",
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

process.stdout.write(`\x1b]0;⌨ Claude Code CLI Monitor - ${sessionId}\x07`);

console.clear();
console.log(`${c.bold}${c.brightCyan}╔══════════════════════════════════════════════════════════════════════════════╗${c.reset}`);
console.log(`${c.bold}${c.brightCyan}║            ⌨ CLAUDE CODE CLI REAL-TIME MONITOR (CODEX)                      ║${c.reset}`);
console.log(`${c.bold}${c.brightCyan}╚══════════════════════════════════════════════════════════════════════════════╝${c.reset}\n`);

let currentMode = null;
let filePosition = 0;
let isFinished = false;
let turnStartMs = null;
let lastStepIndex = null;
let lastToolCallMs = null;
let elapsedTimer = null;

function formatTimestamp(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toTimeString().split(" ")[0];
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function startElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    if (!turnStartMs || isFinished) return;
    const elapsed = formatElapsed(Date.now() - turnStartMs);
    process.stdout.write(`\x1b]0;⌨ Claude Code CLI Monitor - ${sessionId} [${elapsed}]\x07`);
  }, 1000);
  elapsedTimer.unref();
}

function renderEvent(event) {
  switch (event.type) {
    case "meta": {
      console.log(`${c.bold}${c.brightYellow}• Session ID :${c.reset} ${event.session_id}`);
      console.log(`${c.bold}${c.brightYellow}• Model      :${c.reset} ${event.model} (${c.cyan}Effort: ${event.effort || "default"}${c.reset})`);
      console.log(`${c.bold}${c.brightYellow}• Workspace  :${c.reset} ${event.workspace}`);
      console.log(`${c.bold}${c.brightYellow}• Started At :${c.reset} ${event.started_at || new Date().toISOString()}`);
      console.log(`${c.gray}──────────────────────────────────────────────────────────────────────────────${c.reset}`);
      break;
    }

    case "init": {
      console.log(`${c.bold}${c.blue}• Session    :${c.reset} ${event.conversation_id || "pending"}${event.model ? ` ${c.dim}(model: ${event.model})${c.reset}` : ""}`);
      break;
    }

    case "turn_start": {
      turnStartMs = Date.now();
      lastStepIndex = null;
      lastToolCallMs = null;
      startElapsedTimer();
      console.log(`\n${c.bold}${c.brightMagenta}▶ [${formatTimestamp()}] STARTING TURN: ${event.job_id}${c.reset}`);
      console.log(`${c.bold}${c.white}TASK PROMPT:${c.reset}`);
      const promptLines = (event.prompt || "").trim().split("\n");
      for (const line of promptLines) {
        console.log(`  ${c.dim}${line}${c.reset}`);
      }
      console.log(`${c.gray}──────────────────────────────────────────────────────────────────────────────${c.reset}`);
      currentMode = null;
      break;
    }

    case "thought_delta": {
      if (currentMode !== "thought") {
        process.stdout.write(`\n${c.bold}${c.brightCyan}💭 [THINKING]${c.reset} ${c.dim}${c.cyan}`);
        currentMode = "thought";
      }
      process.stdout.write(event.text);
      break;
    }

    case "text_delta": {
      if (currentMode !== "text") {
        process.stdout.write(`\n${c.bold}${c.brightGreen}💬 [OUTPUT]${c.reset}\n`);
        currentMode = "text";
      }
      process.stdout.write(`${c.white}${event.text}${c.reset}`);
      break;
    }

    case "tool_call": {
      currentMode = "tool";
      lastToolCallMs = Date.now();
      const stepTag = event.step_index != null ? `${c.dim} (step ${event.step_index})${c.reset}` : "";
      console.log(`\n${c.bold}${c.brightYellow}⚙️  [TOOL CALL]${c.reset} ${c.bold}${event.name}${c.reset}${stepTag}`);
      if (event.input) {
        const inputStr = typeof event.input === "string" ? event.input : JSON.stringify(event.input, null, 2);
        const lines = inputStr.split("\n");
        for (const l of lines.slice(0, 12)) {
          console.log(`   ${c.yellow}${l}${c.reset}`);
        }
        if (lines.length > 12) {
          console.log(`   ${c.dim}... (${lines.length - 12} more lines)${c.reset}`);
        }
      }
      break;
    }

    case "tool_result": {
      currentMode = "tool";
      let durationTag = "";
      if (lastToolCallMs) {
        const elapsed = Date.now() - lastToolCallMs;
        durationTag = ` ${c.dim}(${formatElapsed(elapsed)})${c.reset}`;
        lastToolCallMs = null;
      }
      console.log(`${c.bold}${c.yellow}📥 [TOOL RESULT]${c.reset} ${c.dim}${event.name}${c.reset}${durationTag}`);
      if (event.output) {
        const outputLines = String(event.output).trim().split("\n");
        for (const l of outputLines.slice(0, 16)) {
          console.log(`   ${c.gray}${l}${c.reset}`);
        }
        if (outputLines.length > 16) {
          console.log(`   ${c.dim}... (${outputLines.length - 16} more lines)${c.reset}`);
        }
      }
      break;
    }

    case "retry": {
      console.log(`${c.bold}${c.brightRed}🔁 [API RETRY]${c.reset} ${c.red}attempt ${event.attempt ?? "?"}/${event.max_retries ?? "?"}${event.error_status ? ` — HTTP ${event.error_status}` : ""}${event.error ? ` ${c.dim}${String(event.error).slice(0, 200)}${c.reset}` : ""}`);
      break;
    }

    case "stderr": {
      console.log(`\n${c.red}${c.bold}[DIAGNOSTICS]${c.reset} ${c.red}${event.text}${c.reset}`);
      break;
    }

    case "step_progress": {
      const p = event.progress || {};
      const stepChanged = p.step_index != null && p.step_index !== lastStepIndex;

      if (stepChanged) {
        if (currentMode === "thought") {
          process.stdout.write(`${c.reset}\n`);
          currentMode = null;
        }
        lastStepIndex = p.step_index;
        const elapsed = turnStartMs ? ` ${c.dim}+${formatElapsed(Date.now() - turnStartMs)}${c.reset}` : "";
        const stepType = p.step_type ? `${c.cyan}${p.step_type}${c.reset}` : "";
        const stateStr = p.state ? `${c.dim}${p.state}${c.reset}` : "";
        const tokensStr = p.total_tokens ? `${c.dim}${p.total_tokens} tok${c.reset}` : "";
        const parts = [stepType, stateStr, tokensStr].filter(Boolean).join(` ${c.gray}|${c.reset} `);
        console.log(`${c.gray}[${formatTimestamp()}]${c.reset} ${c.bold}Step ${p.step_index}${c.reset}${elapsed} ${parts}`);
      }
      break;
    }

    case "turn_complete": {
      currentMode = null;
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
      console.log(`\n${c.gray}──────────────────────────────────────────────────────────────────────────────${c.reset}`);
      const isSuccess = event.status === "completed";
      const bannerColor = isSuccess ? c.brightGreen : c.brightRed;
      const statusIcon = isSuccess ? "✅" : "❌";
      console.log(`${bannerColor}${c.bold}==============================================================================${c.reset}`);
      const exitCode = event.exit_code == null ? "unknown" : event.exit_code;
      console.log(`${bannerColor}${c.bold}  ${statusIcon} TURN FINISHED: ${event.status.toUpperCase()} (Exit Code: ${exitCode})${c.reset}`);
      if (event.diagnostics) {
        console.log(`${c.dim}  • Reason   : ${event.diagnostics}${c.reset}`);
      }
      if (event.duration_s) {
        const m = Math.floor(event.duration_s / 60);
        const s = event.duration_s % 60;
        const durationFmt = m > 0 ? `${m}m${String(s).padStart(2, "0")}s (${event.duration_s}s)` : `${s}s`;
        console.log(`${c.dim}  • Duration : ${durationFmt}${c.reset}`);
      }
      if (event.usage) {
        const u = event.usage;
        const parts = [];
        if (u.input_tokens) parts.push(`in:${u.input_tokens}`);
        if (u.output_tokens) parts.push(`out:${u.output_tokens}`);
        if (u.cache_read_tokens) parts.push(`cache:${u.cache_read_tokens}`);
        if (u.total_tokens) parts.push(`total:${u.total_tokens}`);
        console.log(`${c.dim}  • Tokens   : ${parts.join(" | ")}${c.reset}`);
      }
      if (lastStepIndex != null) {
        console.log(`${c.dim}  • Steps    : ${lastStepIndex + 1} steps executed${c.reset}`);
      }
      console.log(`${bannerColor}${c.bold}==============================================================================${c.reset}\n`);

      if (event.session_ended) {
        isFinished = true;
        promptExit();
      }
      break;
    }

    default:
      break;
  }
}

function promptExit() {
  console.log(`${c.cyan}Execution session finished. Window will remain open for inspection.${c.reset}`);
  console.log(`${c.dim}Press Enter or close this window to exit.${c.reset}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", () => process.exit(0));
  setTimeout(() => process.exit(0), 30 * 60_000).unref();
}

let buffer = "";
function pollLog() {
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size <= filePosition) return;

    const fd = fs.openSync(logPath, "r");
    const readBytes = stat.size - filePosition;
    const readBuf = Buffer.alloc(readBytes);
    fs.readSync(fd, readBuf, 0, readBytes, filePosition);
    fs.closeSync(fd);

    filePosition = stat.size;
    buffer += readBuf.toString("utf8");

    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        renderEvent(event);
      } catch {
        console.log(line);
      }
    }
  } catch (err) {
    // best-effort read
  }
}

const pollTimer = setInterval(pollLog, 80);

process.on("SIGINT", () => process.exit(0));
