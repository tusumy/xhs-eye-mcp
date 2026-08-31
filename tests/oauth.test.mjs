import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationServerMetadata,
  approveAuthorization,
  beginAuthorization,
  digest,
  exchangeToken,
  getAccess,
  protectedResourceMetadata,
  registerClient,
  consumeRateLimit,
} from "../netlify/functions/_shared/oauth.mts";

class MemoryStore {
  values = new Map();
  versions = new Map();
  nextVersion = 1;

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async getWithMetadata(key) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return { data: structuredClone(value), etag: this.versions.get(key), metadata: {} };
  }

  async setJSON(key, value, options = {}) {
    const exists = this.values.has(key);
    if (options.onlyIfNew && exists) return { modified: false };
    if (options.onlyIfMatch && (!exists || this.versions.get(key) !== options.onlyIfMatch)) return { modified: false };
    const etag = `v${this.nextVersion++}`;
    this.values.set(key, structuredClone(value));
    this.versions.set(key, etag);
    return { modified: true, etag };
  }

  async delete(key) {
    this.values.delete(key);
    this.versions.delete(key);
  }
}

function formRequest(url, values) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

test("OAuth discovery exposes only xhs:read and supports PKCE plus refresh tokens", async () => {
  const request = new Request("https://xhs-eye.example/.well-known/oauth-authorization-server");
  const resource = await protectedResourceMetadata(request).json();
  const server = await authorizationServerMetadata(request).json();

  assert.equal(resource.resource, "https://xhs-eye.example/mcp");
  assert.deepEqual(resource.scopes_supported, ["xhs:read"]);
  assert.deepEqual(server.scopes_supported, ["xhs:read"]);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(server.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.equal(server.authorization_response_iss_parameter_supported, true);
});

test("authorization code flow binds resource, verifies PKCE, and rotates refresh tokens", async (t) => {
  const store = new MemoryStore();
  const origin = "https://xhs-eye.example";
  const resource = `${origin}/mcp`;
  const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  const approvalToken = "approval-secret-for-tests";
  const previousNetlify = globalThis.Netlify;
  globalThis.Netlify = { env: { get: (name) => name === "XHS_EYE_APPROVAL_TOKEN" ? approvalToken : undefined } };
  t.after(() => {
    if (previousNetlify === undefined) delete globalThis.Netlify;
    else globalThis.Netlify = previousNetlify;
  });

  const registration = await registerClient(new Request(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  }), store);
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();

  const verifier = "v".repeat(64);
  const challenge = await digest(verifier);
  const authorizeUrl = new URL(`${origin}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "state-123",
    scope: "xhs:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  });
  const authorization = await beginAuthorization(new Request(authorizeUrl), store);
  assert.equal(authorization.status, 200);
  const authorizationPage = await authorization.text();
  assert.match(authorizationPage, /ChatGPT/);
  assert.match(authorizationPage, /chatgpt\.com/);
  const requestId = authorizationPage.match(/name="id" value="([^"]+)"/)?.[1];
  assert.ok(requestId);

  const approval = await approveAuthorization(formRequest(`${origin}/oauth/approve`, {
    id: requestId,
    token: approvalToken,
  }), store);
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "state-123");
  assert.equal(callback.searchParams.get("iss"), origin);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const duplicateApproval = await approveAuthorization(formRequest(`${origin}/oauth/approve`, {
    id: requestId,
    token: approvalToken,
  }), store);
  assert.equal(duplicateApproval.status, 302);
  assert.equal(new URL(duplicateApproval.headers.get("location")).searchParams.get("code"), code);

  const tokenRequest = () => formRequest(`${origin}/oauth/token`, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  });
  const concurrentCodeExchanges = await Promise.all([
    exchangeToken(tokenRequest(), store),
    exchangeToken(tokenRequest(), store),
  ]);
  assert.deepEqual(concurrentCodeExchanges.map((response) => response.status).sort(), [200, 400]);
  const tokenResponse = concurrentCodeExchanges.find((response) => response.status === 200);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.scope, "xhs:read");
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const grant = await getAccess(new Request(`${origin}/mcp`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  }), store);
  assert.equal(grant?.clientId, clientId);
  assert.equal(grant?.resource, resource);

  const wrongResource = await exchangeToken(formRequest(`${origin}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource: "https://wrong.example/mcp",
  }), store);
  assert.equal(wrongResource.status, 400);

  const refreshRequest = () => formRequest(`${origin}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource,
  });
  const concurrentRefreshes = await Promise.all([
    exchangeToken(refreshRequest(), store),
    exchangeToken(refreshRequest(), store),
  ]);
  assert.deepEqual(concurrentRefreshes.map((response) => response.status).sort(), [200, 400]);
  const refreshed = concurrentRefreshes.find((response) => response.status === 200);
  assert.equal(refreshed.status, 200);
  const refreshedTokens = await refreshed.json();
  assert.notEqual(refreshedTokens.refresh_token, tokens.refresh_token);

  const replay = await exchangeToken(formRequest(`${origin}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
    resource,
  }), store);
  assert.equal(replay.status, 400);
});

test("rate limiting remains bounded under concurrent requests", async () => {
  const store = new MemoryStore();
  const grant = {
    clientId: "client",
    resource: "https://xhs-eye.example/mcp",
    scope: "xhs:read",
    tokenKey: "token-key",
  };
  const decisions = await Promise.all(Array.from({ length: 100 }, () => consumeRateLimit(store, grant)));
  assert.equal(decisions.filter(Boolean).length, 30);
  const rotatedTokenGrant = { ...grant, tokenKey: "rotated-token-key" };
  assert.equal(await consumeRateLimit(store, rotatedTokenGrant), false);
  const rateRecords = [...store.values.entries()].filter(([key]) => key.startsWith("rate/"));
  assert.equal(rateRecords.length, 1);
  assert.equal(rateRecords[0][1].count, 30);
});

test("dynamic registration accepts ChatGPT callbacks without durable client records and rejects arbitrary HTTPS origins", async (t) => {
  const store = new MemoryStore();
  const previousNetlify = globalThis.Netlify;
  globalThis.Netlify = { env: { get: (name) => name === "XHS_EYE_APPROVAL_TOKEN" ? "registration-test-secret" : undefined } };
  t.after(() => {
    if (previousNetlify === undefined) delete globalThis.Netlify;
    else globalThis.Netlify = previousNetlify;
  });
  const accepted = await registerClient(new Request("https://xhs-eye.example/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nf-client-connection-ip": "203.0.113.10" },
    body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] }),
  }), store);
  assert.equal(accepted.status, 201);
  assert.equal([...store.values.keys()].some((key) => key.startsWith("clients/")), false);

  const rejected = await registerClient(new Request("https://xhs-eye.example/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nf-client-connection-ip": "203.0.113.11" },
    body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] }),
  }), store);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, "invalid_redirect_uri");

  const nullMetadata = await registerClient(new Request("https://xhs-eye.example/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nf-client-connection-ip": "203.0.113.12" },
    body: "null",
  }), store);
  assert.equal(nullMetadata.status, 400);

  const oversized = await registerClient(new Request("https://xhs-eye.example/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nf-client-connection-ip": "203.0.113.13" },
    body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
  }), store);
  assert.equal(oversized.status, 413);
});

test("authorization rejects a missing or mismatched MCP resource", async (t) => {
  const store = new MemoryStore();
  const previousNetlify = globalThis.Netlify;
  globalThis.Netlify = { env: { get: (name) => name === "XHS_EYE_APPROVAL_TOKEN" ? "resource-test-secret" : undefined } };
  t.after(() => {
    if (previousNetlify === undefined) delete globalThis.Netlify;
    else globalThis.Netlify = previousNetlify;
  });
  const origin = "https://xhs-eye.example";
  const redirectUri = "https://chatgpt.com/connector/oauth/callback-id";
  const registration = await registerClient(new Request(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  }), store);
  const { client_id: clientId } = await registration.json();
  const url = new URL(`${origin}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "state",
    scope: "xhs:read",
    code_challenge: await digest("v".repeat(64)),
    code_challenge_method: "S256",
  });
  const response = await beginAuthorization(new Request(url), store);
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get("location"));
  assert.equal(callback.searchParams.get("error"), "invalid_target");
  assert.equal(callback.searchParams.get("iss"), origin);
});
