import assert from "node:assert/strict";
import test from "node:test";
import { handleMcp, handleRpc, toolDefinitions, withinDeadline } from "../netlify/functions/mcp.mts";

test("xhs_peek is read-only, OAuth protected, and capped at eight frames", () => {
  const [tool] = toolDefinitions();
  assert.equal(tool.name, "xhs_peek");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.inputSchema.properties.max_frames.maximum, 8);
  assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["xhs:read"] }]);
  assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
  assert.ok(tool.outputSchema.required.includes("stats"));
  assert.ok(tool.outputSchema.required.includes("comments"));
});

test("initialize and tools/list return current complete MCP results", async () => {
  const request = new Request("https://xhs-eye.example/mcp", { method: "POST" });
  const initialized = await handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2026-07-28" },
  }, request, null, null);
  assert.equal(initialized.result.protocolVersion, "2026-07-28");

  const listed = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, request, null, null);
  assert.equal(listed.result.resultType, "complete");
  assert.equal(listed.result.tools[0].name, "xhs_peek");
  assert.equal(listed.result.cacheScope, "public");
});

test("unauthorized tool calls carry the ChatGPT OAuth challenge", async () => {
  const request = new Request("https://xhs-eye.example/mcp", { method: "POST" });
  const response = await handleRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "xhs_peek", arguments: { url: "https://xhslink.com/example" } },
  }, request, null, null);
  assert.equal(response.result.resultType, "complete");
  assert.equal(response.result.isError, true);
  const challenge = response.result._meta["mcp/www_authenticate"][0];
  assert.match(challenge, /resource_metadata="https:\/\/xhs-eye\.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /error_description=/);
});

test("MCP rejects oversized JSON-RPC batches", async () => {
  const batch = Array.from({ length: 9 }, (_, index) => ({ jsonrpc: "2.0", id: index + 1, method: "ping" }));
  const response = await handleMcp(new Request("https://xhs-eye.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
  }), null, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /batch/i);
});

test("MCP permits at most one expensive tool call in a batch", async () => {
  const call = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "xhs_peek", arguments: { url: "https://xhslink.com/example" } },
  });
  const response = await handleMcp(new Request("https://xhs-eye.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([call(1), call(2)]),
  }), null, {});
  const body = await response.json();
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /tool call/i);
});

test("MCP rejects oversized JSON before parsing it", async () => {
  const response = await handleMcp(new Request("https://xhs-eye.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(257 * 1024) }),
  }), null, {});
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, -32600);
});

test("storage operations are bounded by the request deadline", async () => {
  const never = new Promise(() => {});
  await assert.rejects(withinDeadline(never, Date.now() + 20, 0), /request_deadline_exceeded/);
});
