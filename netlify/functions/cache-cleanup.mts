import { getStore } from "@netlify/blobs";
import { purgeExpiredCache, purgeExpiredEntries, rotatePrefixes } from "./_shared/cache.mts";

export default async (): Promise<Response> => {
  const startedAt = Date.now();
  const now = Date.now();
  const cacheStore = getStore({ name: "xhs-eye-cache", consistency: "strong" });
  const authStore = getStore({ name: "xhs-eye-auth", consistency: "strong" });
  const cache = await purgeExpiredCache(cacheStore, now, 12_000);
  const remaining = Math.max(1_000, 25_000 - (Date.now() - startedAt));
  const authPrefixes = rotatePrefixes([
    "clients/",
    "requests/",
    "codes/",
    "access/",
    "refresh/",
    "rate/",
    "endpoint-rate/",
  ], Math.floor(now / (60 * 60 * 1000)));
  const auth = await purgeExpiredEntries(authStore, authPrefixes, now, remaining);
  return Response.json({ ok: true, cache, auth });
};

export const config = { schedule: "17 * * * *" };
