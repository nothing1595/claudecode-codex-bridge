# Codex → Claude Code CLI Worker Bridge

A high-performance local Model Context Protocol (MCP) bridge exposing Claude Code CLI (`claude`) as an MCP worker for OpenAI Codex and its subagent fleet. Modeled after `antigravity-codex-bridge`.

## Overview

Instead of proxying or pretending Claude is a native Codex model, this bridge wraps the native **Claude Code CLI (`claude`)** into standard local MCP tools. Codex maintains a single, unified gateway worker (`cc_worker`) that dynamically discovers the models available to your local Claude Code installation (via the Anthropic-compatible gateway `/v1/models`), maps them to friendly `cc_XXX_worker` identifiers, and delegates heavy implementation, refactoring, repository-wide search, and complex multi-step coding tasks directly into the shared workspace.

```
                         Codex Main
                             │
                      Unified Custom Agent
                          (cc_worker)
                             │
                            MCP (stdio JSON-RPC 2.0)
                             │
                server/claudecode-worker.cjs (thin MCP relay)
                             │
                loopback TCP 127.0.0.1:19226 (line-delimited JSON)
                             │
                server/claudecode-broker.cjs (singleton daemon)
                  ├── Dynamic Model Discoverer (gateway /v1/models)
                  ├── Session Manager (1 Custom Agent session = 1 persistent claude process)
                  ├── Job / Turn Queue (FIFO semaphore, default CCB_MAX_PARALLEL_JOBS = 2)
                  └── Stream-JSON Parser & Progress Tracker
                             │
                             │ stdin:  {"type":"user","message":{"role":"user","content":"..."}}
                             │ stdout: system/init -> assistant* -> result
                             ▼
                  Persistent child_process `claude.exe`
                  --print --verbose --input-format stream-json
                  --output-format stream-json
                             │
                  Claude Code Agent Harness (yolo or safe mode)
                             │
                  CPA gateway (allowlist: 127.0.0.1:8317 / localhost:8317)
                  — injected ANTHROPIC_BASE_URL/AUTH_TOKEN, API key stripped,
                    preflight /v1/models health check, fail-closed
                             │
                  Selected Model (alias, gateway slug, or user default)
                             │
                             ▼
                  Target Shared Workspace
```

---

## Single Gateway Worker (`cc_worker`) & Dynamic Model Selection

To keep the Codex custom agents list clean and clutter-free, only **one** agent is registered: **`cc_worker`**.

> [!IMPORTANT]
> **Model Aliases vs. Real Codex Custom Agent**:
> `cc_worker` is the **only true Codex Custom Agent** (`.codex/agents/cc-worker.toml`). Identifiers such as `cc_sonnet_worker`, `cc_opus_worker`, and `cc_gpt5.6luna_worker` are **model-selection aliases** recognized by `run_task(model="...")`. Codex Main delegates to `cc_worker`, which discovers models via `list_models()`, presents the aliases to the user, and forwards the chosen alias to the bridge.

When assigned in Codex:
1. **Model Discovery & Feedback**:
   If the user has not specified a model or asks what models are available, `cc_worker` invokes `list_models` and presents the available model families formatted as `cc_XXX_worker`, for example:
   - `cc_claudeopus4.6_worker` — Claude Opus 4.6 (最高推理: Thinking)
   - `cc_claudesonnet4.6_worker` — Claude Sonnet 4.6 (最高推理: Thinking)
   - `cc_gpt5.6luna_worker` — GPT 5.6 Luna [openai]
   - `cc_sonnet_worker` / `cc_opus_worker` / `cc_haiku_worker` / `cc_fable_worker` — built-in aliases resolving to the user's own Claude Code model mappings
2. **Default Model Behaviour**:
   Omitting `model` omits `--model` entirely, so Claude Code applies the user's own configured default (`~/.claude/settings.json` / env). This is the recommended dispatch on gateway-proxied setups.
3. **Execution**:
   Once chosen, `cc_worker` calls `run_task` with the chosen model to execute the implementation.

---

## CPA-Only Fail-Closed Routing

This bridge does not merely *prefer* the local CPA gateway (CLIProxyAPI) — it **guarantees** that every Claude Code model request goes through it, and refuses to run otherwise. Model discovery, execution environment injection, `run_task` preflight and the URL allowlist all resolve from the **same** `getGatewayConfig()` chain (`CCB_GATEWAY_BASE_URL` / `CCB_GATEWAY_AUTH_TOKEN` → `~/.claude/settings.json` `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` → process env), so "list_models shows CPA models" and "Claude actually talks to CPA" can never diverge.

Enforcement happens at four layers:

1. **URL allowlist** — the resolved gateway must be `http://127.0.0.1:8317` or `http://localhost:8317` (override via `CCB_ALLOWED_GATEWAY_URLS`). `https://api.anthropic.com` — or any other endpoint — is rejected outright.
2. **Preflight health check** — every `run_task` (new session) probes `GET <gateway>/v1/models` first. Connection refused, timeout, 401/403, or any non-2xx (except 429) refuses dispatch with a clear error. 429 (quota exhausted) is treated as "gateway alive" and allowed to proceed since Claude Code retries internally.
3. **Explicit environment injection** — spawned `claude.exe` processes receive `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` injected directly; any ambient `ANTHROPIC_API_KEY` inherited from the parent environment is deleted, so an official key can never silently take over.
4. **Configuration conflict detection** — Claude Code re-applies its own `settings.json` env over the process environment; if `CCB_GATEWAY_BASE_URL` and `~/.claude/settings.json` `ANTHROPIC_BASE_URL` disagree, the bridge refuses to dispatch rather than gamble on which layer wins.

The installer applies the same policy: missing gateway config, off-allowlist URLs, bad credentials, or an unreachable gateway abort the installation (fail-closed).

Model-list caching is deliberately decoupled from execution: `list_models` may keep serving the persistent cache (`stale: true`) while the gateway is temporarily down — display stays available, but `run_task` remains hard-blocked until CPA is healthy again.

| Situation | `list_models` | `run_task` |
|---|---|---|
| CPA healthy | live discovery | ✅ allowed |
| CPA rate-limited (429) | cached/stale | ✅ allowed (Claude retries) |
| CPA down / unreachable | cached/stale | ❌ refused (preflight failed) |
| CPA misconfigured / off-allowlist / token missing | built-in/cached | ❌ refused |

Set `CCB_GATEWAY_REQUIRED=0` to restore the legacy fail-open (CPA-aware) behaviour for offline development.

---

## Key Advantages

1. **Persistent CLI Process (`--input-format stream-json`)**:
   `claude --print --verbose --input-format stream-json --output-format stream-json` keeps one process alive across all turns in a Codex conversation. Follow-up turns are sent straight into the running process's `stdin`, eliminating process startup and reload latencies.
2. **Headless by Nature (No CDP / No Window Mutex)**:
   Does not require Chrome DevTools Protocol or physical window UI clicking. Tasks run truly headless in the background.
3. **Native Real-time Telemetry (`stream-json`)**:
   `system/init`, `assistant` (text / thinking / tool_use blocks), tool results, `system/api_retry`, and `result` events provide immediate session ids, active tool calls, incremental tokens, and streaming text without polling external databases.
4. **Native Permission Bypass & Autonomous Mode**:
   `--dangerously-skip-permissions` (yolo) or `--permission-mode acceptEdits` (safe) enables fully unattended execution without interactive permission pauses.
5. **Session-Level Lazy Recovery (Fail-Fast & Auto-Resume)**:
   If the underlying `claude` process terminates or crashes during a turn, the current task fails safely without blind destructive re-execution. The native `claude_session_id` is preserved in the session, and the next `continue_task` call automatically revives the session via `claude --resume <session_id>`. The csess → claude_session_id mapping is also persisted to `%USERPROFILE%\.claudecode-codex-bridge\sessions\`, so `continue_task` keeps working even across a full broker crash/restart.
6. **At-Most-Once Prompt Dispatch**:
   Claude Code only emits `system/init` after the first user message, so startup cannot be confirmed before the prompt is sent. The bridge therefore enforces at-most-once semantics: spawn-level failures *before* the prompt leaves the broker are retried (up to 3 attempts), but once the prompt is written to the claude process's stdin, any subsequent startup failure fails the job with `EDISPATCH_UNCERTAIN` ("prompt may have partially executed") instead of silently re-sending a non-idempotent task. Recovery is always the caller's explicit decision.
7. **Active Process Tree Termination & Clean Shutdown**:
   When a task exceeds its configured `timeout_minutes`, experiences extended stall silence, or is cancelled, the broker actively and recursively kills the entire subprocess tree (`taskkill /T /F`). When the broker shuts down, it asynchronously awaits process tree termination across all persistent sessions before closing server sockets.
8. **True Long-Running Task Support (Default 4-Hour Deadline)**:
   Tasks default to 240 minutes (4 hours, bounded by `CCB_TASK_TIMEOUT_MS`). The bridge never prematurely aborts healthy long-running refactoring or multi-module coding tasks.
9. **Stream-JSON Result Integrity**:
   A turn only succeeds when stream-json delivers a `result` event with `subtype === "success"` and `is_error` falsy. If the CLI process closes unexpectedly (even with exit code 0) before emitting `result`, the turn is immediately and accurately marked as `failed`.
10. **Visible Desktop CLI Execution Monitor (`claudecode-viewer.cjs`)**:
   By default on Windows (`CCB_SHOW_WINDOW=1`), when a task is dispatched, a dedicated terminal window titled `Claude Code CLI Monitor - [Model]` pops up on your desktop, rendering a colorized real-time HUD with streaming thoughts, live tool invocations, tool outputs, API retry warnings, and assistant text. The window remains open for review after completion.
11. **Host User Security Context Bridge (`ClaudeCodeBroker`)**:
    Codex often runs MCP wrappers under a restricted Windows sandbox user account (`codexsandboxoffline`), where Claude Code credentials and gateway tokens do not exist. The bridge registers and utilizes a user-level Windows Scheduled Task (`schtasks /Run /TN ClaudeCodeBroker`) so that the broker daemon is always launched within the interactive host user session, retaining full authenticated access to Claude Code settings, gateway tokens, file permissions, and the desktop display.
12. **Fast-Path Model Resolution & Non-Idempotent Protection**:
    Known aliases (`sonnet`, `cc_sonnet_worker`, `opus`, …) resolve instantly in 0ms without touching the gateway. Non-idempotent dispatches (`run_task`, `continue_task`) are strictly protected against duplicate retry loops.
13. **Reliable Dynamic Model Discovery, Singleton Concurrency & Persistent Caching**:
    - **Singleflight Singleton Query**: at most one gateway `/v1/models` request runs at any moment.
    - **Finite Retry & Backoff**: queries employ explicit per-attempt timeouts (`CCB_GATEWAY_TIMEOUT_MS`, default 12s), up to 2 retries with linear backoff, and early exit on auth / misconfiguration errors.
    - **Persistent Host Cache**: discovered model families are persisted to `%USERPROFILE%\.claudecode-codex-bridge\models-cache.json` (with timestamps, source, and family counts). Across broker restarts or offline periods, all discovered models remain available immediately.
    - **Non-Destructive Stale Degradation**: if a dynamic refresh fails, the last known complete model list is served with `stale: true` plus `diagnostics`. Temporary failures never overwrite valid caches; built-in aliases (sonnet/opus/haiku/fable) are used only if no cache has ever existed.
    - **Robust Quality Gates**: raw payloads are structurally validated, slugs syntax-checked, duplicates removed, duplicate floods rejected, and severe shrinkage (< 50% family retention vs cache) rejected as `partial_result`.
14. **Gateway-Aware Effort Handling**:
    Claude Code supports `--effort low|medium|high|xhigh|max`, but gateway model slugs often encode effort themselves (e.g. `fable-test-high`). The bridge only forwards `--effort` when explicitly requested; it never injects one by default.

---

## Architectural Boundary: Agent MCP vs. Global MCP Registration

- **Agent-Level Registration (`agents/cc-worker.toml`)**:
  The primary recommended pattern: Codex Main delegates tasks to `cc_worker`, which possesses specialized instructions for model discovery, feedback loops, and long-polling progress monitoring.
- **Global Registration (`config.toml`)**:
  Registered globally so that Codex Main can also directly inspect or invoke `claudecode_worker` tools if needed. This does not interfere with the custom agent flow and gives flexibility for direct workflows.

---

## MCP Tools Reference

- **`list_models(detailed?)`**: Queries the Anthropic-compatible gateway `/v1/models`, aggregates models into families, and returns the list of `cc_XXX_worker` identifiers.
  - By default, returns an array of model family objects.
  - Each item includes `stale` (boolean), `source` (`gateway_models_api`, `file_cache`, or `built_in_defaults`), and optional `diagnostics`.
  - Passing `detailed=true` returns an envelope: `{ models, count, stale, source, diagnostics, timestamp }`.
- **`run_task(workspace, task, model?, effort?, agent?, permission_mode?, timeout_minutes?)`**: Starts a persistent Claude Code session in the workspace. Supports model aliases (e.g. `cc_sonnet_worker`, `sonnet`), gateway slugs, or omitting `model` to use the user-configured default. Defaults to a 240-minute (4-hour) timeout for deep tasks. Fails closed when the CPA gateway is missing, off-allowlist, conflicting, or unreachable (see [CPA-Only Fail-Closed Routing](#cpa-only-fail-closed-routing)).
- **`continue_task(session_id, task, timeout_minutes?)`**: Sends a follow-up turn prompt directly to the running session's stdin; lazily revives dead sessions via `--resume`.
- **`get_status(job_id, wait_ms?, since_event_seq?)`**: Long-polling status and live progress telemetry. The response carries `event_seq`, incremented on every meaningful stream event (assistant text/thinking/tool_use, tool results, api retries, stderr); passing it back as `since_event_seq` wakes the poll immediately on any new activity instead of waiting out the full window.
- **`cancel_task(job_id)`**: Gracefully stops the active turn and halts the subprocess tree.

---

## Installation & Startup

Run the PowerShell installer:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-agents.ps1
```

The installer will:
1. Query the gateway `/v1/models` to verify local model availability.
2. Clean up any obsolete agent files.
3. Render and install the unified `cc-worker.toml` into your Codex `agents/` directory.
4. Register the `claudecode_worker` MCP server in Codex `config.toml`.
5. Register the `ClaudeCodeBroker` user-level Windows Scheduled Task with permissions for sandbox users.
6. Launch the host broker daemon in the authenticated interactive user session via `scripts\start-broker.ps1`.

To manually start or verify the broker daemon at any time:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-broker.ps1
```

Restart Codex, then ask it to assign **`cc_worker`**.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CCB_CLAUDE_EXE` | Auto-detected | Absolute path to `claude.exe` (also honors `CODEXHOST_CLAUDE_COMMAND`). |
| `CCB_NODE_EXE` | Auto-detected | Path to Node.js binary (installer only). |
| `CCB_BROKER_PORT` | `19226` | Broker TCP daemon loopback port. |
| `CCB_MAX_PARALLEL_JOBS` | `2` | Maximum concurrent active turns. |
| `CCB_BROKER_IDLE_MS` | `0` (persistent) | Broker auto-exit timeout when idle. |
| `CCB_TASK_TIMEOUT_MS` | `14400000` (4h) | Hard deadline timeout for a single task. |
| `CCB_DEFAULT_TIMEOUT_MINUTES` | `240` (4h) | Default per-task timeout when `timeout_minutes` is omitted or invalid. |
| `CCB_TASK_IDLE_TIMEOUT_MS` | `1800000` (30m) | Stall detection: stream-silence timeout before failing a job (generous enough for long model thinking / backend waits). |
| `CCB_TASK_TOOL_IDLE_TIMEOUT_MS` | `5400000` (90m) | Silence timeout while the latest stream step is a tool execution (long local commands / experiments). |
| `CCB_SHOW_WINDOW` | `1` | Set to `1` to pop up the desktop CLI monitor window, `0` for headless. |
| `CCB_GATEWAY_BASE_URL` | From `~/.claude/settings.json` | Override the model discovery gateway base URL (tests). |
| `CCB_GATEWAY_AUTH_TOKEN` | From `~/.claude/settings.json` | Override the gateway auth token (tests). |
| `CCB_GATEWAY_REQUIRED` | `1` | CPA-only fail-closed enforcement. `0` restores legacy fail-open behaviour. |
| `CCB_ALLOWED_GATEWAY_URLS` | `http://127.0.0.1:8317,http://localhost:8317` | Comma-separated allowlist; Claude Code is only ever launched for gateways on this list. |
| `CCB_GATEWAY_HEALTH_TTL_MS` | `30000` (30s) | Preflight health-check result cache TTL for `run_task`. |
| `CCB_MODELS_CACHE_FILE` | `%USERPROFILE%\.claudecode-codex-bridge\models-cache.json` | Persistent model cache file path. |
| `CCB_MODELS_CACHE_TTL_MS` | `300000` (5m) | In-memory models cache TTL. |
| `CCB_GATEWAY_TIMEOUT_MS` | `12000` (12s) | Per-attempt timeout for gateway `/v1/models`. |
| `CCB_GATEWAY_RETRIES` | `2` | Retry attempts upon query failure. |
| `CCB_GATEWAY_BACKOFF_MS` | `800` | Linear backoff delay multiplier. |
| `CCB_USER_PROFILE` | `C:\Users\15869` | Host user profile the broker executes under. |
| `CCB_BROKER_LOG` | `%TEMP%\claudecode-broker.log` | Broker diagnostic log path. |
| `CCB_SESSIONS_DIR` | `%USERPROFILE%\.claudecode-codex-bridge\sessions` | Durable session registry (csess → claude_session_id mapping) restored on broker restart. |

---

## Verification & Smoke Tests

Run lightweight model discovery, persistent caching, singleflight, and fast-path tests (uses a local fixture HTTP server; does not touch real credentials):
```powershell
& "E:\Node.js\node.exe" scripts\test-model-discovery.cjs
```

Run dynamic model discovery, alias resolution, and multi-turn continuation test:
```powershell
& "E:\Node.js\node.exe" scripts\smoke-run.cjs .
```
Optionally pass an explicit model (`sonnet`, a `cc_XXX_worker` alias, or a gateway slug):
```powershell
& "E:\Node.js\node.exe" scripts\smoke-run.cjs . cc_sonnet_worker
```

Run parallel execution smoke test (2 concurrent jobs):
```powershell
& "E:\Node.js\node.exe" scripts\smoke-parallel.cjs .
```

Run graceful cancellation test:
```powershell
& "E:\Node.js\node.exe" scripts\smoke-parallel.cjs . --cancel
```
