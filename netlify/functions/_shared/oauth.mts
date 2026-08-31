import type { Store } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

const READ_SCOPE = "xhs:read";
const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const CLIENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 30;
const MAX_JSON_BODY_BYTES = 32 * 1024;
const MAX_FORM_BODY_BYTES = 8 * 1024;
const MAX_AUTHORIZATION_URL_LENGTH = 12 * 1024;
const CHATGPT_CALLBACK_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

type Json = Record<string, unknown>;
type Client = { client_name: string; redirect_uris: string[]; created_at: string; expires_at: string };
type AuthRequest = {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: string;
  code_challenge: string;
  resource: string;
  issuer: string;
  expires_at: string;
  approved?: boolean;
};
type Code = {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  resource: string;
  expires_at: string;
  used: boolean;
};
type Token = { client_id: string; scope: string; resource: string; expires_at: string; revoked?: boolean };
type Rate = { count: number; window_started_at: string };

export type AccessGrant = {
  clientId: string;
  resource: string;
  scope: string;
  tokenKey: string;
};

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache", ...headers } });
}

function html(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function origin(request: Request): string {
  return new URL(request.url).origin;
}

function resource(request: Request): string {
  return `${origin(request)}/mcp`;
}

function clientIp(request: Request): string {
  return request.headers.get("x-nf-client-connection-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function expiryOptions(expiresAt: string): { metadata: { expires_at: string } } {
  return { metadata: { expires_at: expiresAt } };
}

function approvalSecret(): string {
  return Netlify.env.get("XHS_EYE_APPROVAL_TOKEN") || "";
}

function randomToken(size = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

async function load<T>(store: Store, key: string): Promise<T | null> {
  return await store.get(key, { type: "json" }) as T | null;
}

async function loadForUpdate<T>(store: Store, key: string): Promise<{ record: T; etag: string } | null> {
  const entry = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (!entry?.etag) return null;
  return { record: entry.data as T, etag: entry.etag };
}

async function readTextLimited(request: Request, limit: number): Promise<string> {
  const announced = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(announced) && announced > limit) throw new RangeError("request_too_large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RangeError("request_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

function allowedRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (loopback) return url.protocol === "http:" || url.protocol === "https:";
    return url.protocol === "https:" && !url.port && CHATGPT_CALLBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

async function consumeCounter(store: Store, key: string, limit: number, windowMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < limit + 4; attempt += 1) {
    const now = Date.now();
    const current = await loadForUpdate<Rate>(store, key);
    if (!current) {
      const expiresAt = new Date(now + windowMs).toISOString();
      const created = await store.setJSON(key, {
        count: 1,
        window_started_at: new Date(now).toISOString(),
      } satisfies Rate, { onlyIfNew: true, ...expiryOptions(expiresAt) });
      if (created.modified) return true;
      continue;
    }
    const expired = Date.parse(current.record.window_started_at) <= now - windowMs;
    if (!expired && current.record.count >= limit) return false;
    const next: Rate = expired
      ? { count: 1, window_started_at: new Date(now).toISOString() }
      : { ...current.record, count: current.record.count + 1 };
    const expiresAt = new Date(Date.parse(next.window_started_at) + windowMs).toISOString();
    const updated = await store.setJSON(key, next, { onlyIfMatch: current.etag, ...expiryOptions(expiresAt) });
    if (updated.modified) return true;
  }
  return false;
}

async function consumeEndpointRate(store: Store, request: Request, endpoint: string, limit: number): Promise<boolean> {
  const ipKey = await digest(clientIp(request));
  return await consumeCounter(store, `endpoint-rate/${endpoint}/${ipKey}`, limit, RATE_WINDOW_MS);
}

function normalizedScope(scope: string): string | null {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  return scopes.size === 1 && scopes.has(READ_SCOPE) ? READ_SCOPE : null;
}

function validPkceChallenge(value: string): boolean {
  return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function validPkceVerifier(value: string): boolean {
  return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value);
}

async function safeSecretEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  const leftBytes = Buffer.from(leftDigest);
  const rightBytes = Buffer.from(rightDigest);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function signClientPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function encodeClient(client: Client, secret: string): string {
  const payload = Buffer.from(JSON.stringify(client)).toString("base64url");
  return `${payload}.${signClientPayload(payload, secret)}`;
}

async function decodeClient(clientId: string, secret: string): Promise<Client | null> {
  const [payload, signature, extra] = clientId.split(".");
  if (!payload || !signature || extra || clientId.length > 4_096) return null;
  if (!await safeSecretEqual(signature, signClientPayload(payload, secret))) return null;
  try {
    const client = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Client;
    if (typeof client.client_name !== "string" || !Array.isArray(client.redirect_uris) || !client.redirect_uris.length || client.redirect_uris.length > 5) return null;
    if (!client.redirect_uris.every(allowedRedirect) || !client.created_at || !client.expires_at || Date.parse(client.expires_at) <= Date.now()) return null;
    return client;
  } catch {
    return null;
  }
}

function authorizationError(redirectUri: string, state: string, issuer: string, error: string): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state) target.searchParams.set("state", state);
  target.searchParams.set("iss", issuer);
  return Response.redirect(target, 302);
}

export function protectedResourceMetadata(request: Request): Response {
  const base = origin(request);
  return json(200, {
    resource: resource(request),
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [READ_SCOPE],
  });
}

export function authorizationServerMetadata(request: Request): Response {
  const base = origin(request);
  return json(200, {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [READ_SCOPE],
    authorization_response_iss_parameter_supported: true,
  });
}

export async function registerClient(request: Request, store: Store): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!await consumeEndpointRate(store, request, "register", 20)) return json(429, { error: "slow_down" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextLimited(request, MAX_JSON_BODY_BYTES));
  } catch (error) {
    if (error instanceof RangeError) return json(413, { error: "invalid_client_metadata" });
    return json(400, { error: "invalid_client_metadata" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, { error: "invalid_client_metadata" });
  const input = parsed as Json;
  const rawUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  const redirectUris = [...new Set(rawUris.filter(allowedRedirect))];
  if (!redirectUris.length || redirectUris.length !== rawUris.length) return json(400, { error: "invalid_redirect_uri" });
  if (redirectUris.length > 5) return json(400, { error: "invalid_client_metadata" });
  if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== "none") return json(400, { error: "invalid_client_metadata" });
  const secret = approvalSecret();
  if (!secret) return json(503, { error: "server_error" });
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLIENT_TTL_MS).toISOString();
  const rawClientName = typeof input.client_name === "string" ? input.client_name.slice(0, 120) : "ChatGPT";
  const client: Client = {
    client_name: rawClientName.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "ChatGPT",
    redirect_uris: redirectUris,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  const clientId = encodeClient(client, secret);
  if (clientId.length > 4_096) return json(400, { error: "invalid_client_metadata" });
  return json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

export async function beginAuthorization(request: Request, store: Store): Promise<Response> {
  if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (request.url.length > MAX_AUTHORIZATION_URL_LENGTH) return json(414, { error: "invalid_request" });
  if (!await consumeEndpointRate(store, request, "authorize", 40)) return json(429, { error: "slow_down" });
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state") || "";
  const scope = normalizedScope(url.searchParams.get("scope") || READ_SCOPE);
  const challenge = url.searchParams.get("code_challenge") || "";
  const requestedResource = url.searchParams.get("resource") || "";
  const issuer = origin(request);
  if (clientId.length > 4_096 || redirectUri.length > 2_048 || state.length > 1_024 || requestedResource.length > 2_048 || (url.searchParams.get("scope") || "").length > 64) return json(400, { error: "invalid_request" });
  const secret = approvalSecret();
  const client = secret ? await decodeClient(clientId, secret) : null;
  if (!client || !client.redirect_uris.includes(redirectUri)) return json(400, { error: "invalid_request", error_description: "Unknown client or redirect URI" });
  if (requestedResource !== resource(request)) return authorizationError(redirectUri, state, issuer, "invalid_target");
  if (url.searchParams.get("response_type") !== "code" || !state || !scope || url.searchParams.get("code_challenge_method") !== "S256" || !validPkceChallenge(challenge)) return authorizationError(redirectUri, state, issuer, "invalid_request");
  const id = randomToken(24);
  const record: AuthRequest = {
    id,
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope,
    code_challenge: challenge,
    resource: requestedResource,
    issuer,
    expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
  };
  await store.setJSON(`requests/${id}`, record, expiryOptions(record.expires_at));
  const clientName = escapeHtml(client.client_name);
  const callbackOrigin = escapeHtml(new URL(redirectUri).origin);
  return html(200, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小红书眼睛 · 授权</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111016;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.card{width:min(84vw,420px);padding:32px;border:1px solid #ffffff24;border-radius:28px;background:#ffffff0d;box-shadow:0 28px 80px #0009}h1{font-size:25px;margin:0 0 10px}p{color:#c9c3d3;line-height:1.55}.origin{font-size:13px;color:#91899e;word-break:break-all}input,button{box-sizing:border-box;width:100%;height:48px;border-radius:14px;font-size:16px}input{margin:14px 0 10px;padding:0 14px;border:1px solid #ffffff2e;background:#0c0b10;color:#fff}button{border:0;background:#e93f5d;color:#fff;font-weight:700}</style></head><body><main class="card"><h1>允许 ${clientName} 看小红书</h1><p>仅授予读取小红书笔记的 xhs:read 权限，不包含任何写入权限。</p><p class="origin">授权结果将返回：${callbackOrigin}</p><form method="post" action="/oauth/approve"><input type="hidden" name="id" value="${id}"><input name="token" type="password" autocomplete="one-time-code" placeholder="粘贴小红书眼睛授权码" required><button type="submit">允许连接</button></form></main></body></html>`);
}

export async function approveAuthorization(request: Request, store: Store): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!await consumeEndpointRate(store, request, "approve", 20)) return json(429, { error: "slow_down" });
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readTextLimited(request, MAX_FORM_BODY_BYTES));
  } catch (error) {
    return json(error instanceof RangeError ? 413 : 400, { error: "invalid_request" });
  }
  const id = form.get("id") || "";
  const supplied = form.get("token") || "";
  if (id.length > 128 || supplied.length > 512) return json(400, { error: "invalid_request" });
  const expected = approvalSecret();
  const requestKey = `requests/${id}`;
  const current = await loadForUpdate<AuthRequest>(store, requestKey);
  const record = current?.record;
  if (!record || record.approved || Date.parse(record.expires_at) <= Date.now()) return html(400, "<!doctype html><meta charset=utf-8><p>授权已失效，请回到 ChatGPT 重试。</p>");
  if (!expected || !supplied || !await safeSecretEqual(expected, supplied)) return html(403, "<!doctype html><meta charset=utf-8><p>授权码不对。</p>");
  const claimed = await store.setJSON(requestKey, { ...record, approved: true }, { onlyIfMatch: current.etag, ...expiryOptions(record.expires_at) });
  if (!claimed.modified) return html(400, "<!doctype html><meta charset=utf-8><p>授权已失效，请回到 ChatGPT 重试。</p>");
  const code = randomToken(32);
  const codeRecord: Code = {
    client_id: record.client_id,
    redirect_uri: record.redirect_uri,
    scope: record.scope,
    code_challenge: record.code_challenge,
    resource: record.resource,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    used: false,
  };
  await store.setJSON(`codes/${await digest(code)}`, codeRecord, expiryOptions(codeRecord.expires_at));
  await store.delete(requestKey);
  const target = new URL(record.redirect_uri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", record.state);
  target.searchParams.set("iss", record.issuer);
  return Response.redirect(target, 302);
}

async function issueTokens(store: Store, clientId: string, scope: string, tokenResource: string): Promise<Json> {
  const access = randomToken(32);
  const refresh = randomToken(40);
  const accessExpiresAt = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  await store.setJSON(`access/${await digest(access)}`, {
    client_id: clientId,
    scope,
    resource: tokenResource,
    expires_at: accessExpiresAt,
  } satisfies Token, expiryOptions(accessExpiresAt));
  await store.setJSON(`refresh/${await digest(refresh)}`, {
    client_id: clientId,
    scope,
    resource: tokenResource,
    expires_at: refreshExpiresAt,
  } satisfies Token, expiryOptions(refreshExpiresAt));
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    scope,
  };
}

export async function exchangeToken(request: Request, store: Store): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!await consumeEndpointRate(store, request, "token", 120)) return json(429, { error: "slow_down" });
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readTextLimited(request, MAX_FORM_BODY_BYTES));
  } catch (error) {
    return json(error instanceof RangeError ? 413 : 400, { error: "invalid_request" });
  }
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    const code = form.get("code") || "";
    const clientId = form.get("client_id") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const verifier = form.get("code_verifier") || "";
    const requestedResource = form.get("resource") || "";
    if (code.length > 256 || clientId.length > 4_096 || redirectUri.length > 2_048 || verifier.length > 128 || requestedResource.length > 2_048) return json(400, { error: "invalid_grant" });
    const key = `codes/${await digest(code)}`;
    const current = await loadForUpdate<Code>(store, key);
    const record = current?.record;
    if (!record || record.used || Date.parse(record.expires_at) <= Date.now() || record.client_id !== clientId || record.redirect_uri !== redirectUri || record.resource !== requestedResource || requestedResource !== resource(request) || !validPkceVerifier(verifier) || await digest(verifier) !== record.code_challenge) {
      return json(400, { error: "invalid_grant" });
    }
    const claimed = await store.setJSON(key, { ...record, used: true }, { onlyIfMatch: current.etag, ...expiryOptions(record.expires_at) });
    if (!claimed.modified) return json(400, { error: "invalid_grant" });
    const tokens = await issueTokens(store, clientId, record.scope, record.resource);
    await store.delete(key);
    return json(200, tokens);
  }
  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token") || "";
    const clientId = form.get("client_id") || "";
    const requestedResource = form.get("resource") || "";
    if (refresh.length > 256 || clientId.length > 4_096 || requestedResource.length > 2_048) return json(400, { error: "invalid_grant" });
    const key = `refresh/${await digest(refresh)}`;
    const current = await loadForUpdate<Token>(store, key);
    const record = current?.record;
    if (!record || record.revoked || Date.parse(record.expires_at) <= Date.now() || record.client_id !== clientId || record.resource !== requestedResource || requestedResource !== resource(request)) return json(400, { error: "invalid_grant" });
    const claimed = await store.setJSON(key, { ...record, revoked: true }, { onlyIfMatch: current.etag, ...expiryOptions(record.expires_at) });
    if (!claimed.modified) return json(400, { error: "invalid_grant" });
    const tokens = await issueTokens(store, clientId, record.scope, record.resource);
    await store.delete(key);
    return json(200, tokens);
  }
  return json(400, { error: "unsupported_grant_type" });
}

export async function getAccess(request: Request, store: Store): Promise<AccessGrant | null> {
  const value = bearer(request);
  if (!value) return null;
  const tokenKey = await digest(value);
  const record = await load<Token>(store, `access/${tokenKey}`);
  if (!record || record.revoked || record.resource !== resource(request) || !record.scope.split(/\s+/).includes(READ_SCOPE) || Date.parse(record.expires_at) <= Date.now()) return null;
  return { clientId: record.client_id, resource: record.resource, scope: record.scope, tokenKey };
}

export async function hasAccess(request: Request, store: Store): Promise<boolean> {
  return Boolean(await getAccess(request, store));
}

export async function consumeRateLimit(store: Store, grant: AccessGrant): Promise<boolean> {
  const grantKey = await digest(`${grant.clientId}\n${grant.resource}`);
  return await consumeCounter(store, `rate/${grantKey}`, RATE_LIMIT, RATE_WINDOW_MS);
}

export function authChallenge(request: Request): string {
  const metadata = `${origin(request)}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer resource_metadata="${metadata}", scope="${READ_SCOPE}", error="insufficient_scope", error_description="Authorize xhs:read to continue"`;
}

export function unauthorized(request: Request): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": authChallenge(request),
    },
  });
}

export function authScheme(): Json[] {
  return [{ type: "oauth2", scopes: [READ_SCOPE] }];
}
