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
