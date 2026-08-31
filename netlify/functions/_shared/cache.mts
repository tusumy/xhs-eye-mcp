import type { Store } from "@netlify/blobs";

const CACHE_PREFIX = "peek/";

type CacheRecord<T> = {
  created_at: string;
  expires_at: string;
  result: T;
};

export function rotatePrefixes(prefixes: string[], seed: number): string[] {
  if (!prefixes.length) return [];
  const offset = ((Math.trunc(seed) % prefixes.length) + prefixes.length) % prefixes.length;
  return [...prefixes.slice(offset), ...prefixes.slice(0, offset)];
}

export async function readFreshCache<T>(store: Store, key: string, now = Date.now()): Promise<T | null> {
  const fullKey = `${CACHE_PREFIX}${key}`;
  const cached = await store.get(fullKey, { type: "json" }) as CacheRecord<T> | null;
  if (!cached?.result || !cached.expires_at || Date.parse(cached.expires_at) <= now) {
    if (cached) await store.delete(fullKey);
    return null;
  }
  return cached.result;
}

export async function writeCache<T>(store: Store, key: string, result: T, cacheHours: number, now = Date.now()): Promise<void> {
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + cacheHours * 60 * 60 * 1000).toISOString();
  await store.setJSON(`${CACHE_PREFIX}${key}`, {
    created_at: createdAt,
    expires_at: expiresAt,
    result,
  } satisfies CacheRecord<T>, { metadata: { expires_at: expiresAt } });
}

export async function purgeExpiredEntries(store: Store, prefixes: string[], now = Date.now(), budgetMs = 25_000): Promise<{ scanned: number; deleted: number; complete: boolean }> {
  const deadline = Date.now() + budgetMs;
  let scanned = 0;
  let deleted = 0;
  for (const prefix of prefixes) {
    for await (const page of store.list({ prefix, paginate: true })) {
      for (let offset = 0; offset < page.blobs.length; offset += 16) {
        if (Date.now() >= deadline) return { scanned, deleted, complete: false };
        const chunk = page.blobs.slice(offset, offset + 16);
        const decisions = await Promise.all(chunk.map(async ({ key }) => {
          const entry = await store.getMetadata(key, { consistency: "strong" });
          const expiresAt = typeof entry?.metadata?.expires_at === "string" ? entry.metadata.expires_at : "";
          if (!expiresAt || Date.parse(expiresAt) <= now) {
            await store.delete(key);
            return true;
          }
          return false;
        }));
        scanned += chunk.length;
        deleted += decisions.filter(Boolean).length;
      }
    }
  }
  return { scanned, deleted, complete: true };
}

export async function purgeExpiredCache(store: Store, now = Date.now(), budgetMs = 25_000): Promise<{ scanned: number; deleted: number; complete: boolean }> {
  return await purgeExpiredEntries(store, [CACHE_PREFIX], now, budgetMs);
}
