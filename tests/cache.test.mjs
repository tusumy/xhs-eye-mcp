import assert from "node:assert/strict";
import test from "node:test";
import { purgeExpiredCache, readFreshCache, rotatePrefixes, writeCache } from "../netlify/functions/_shared/cache.mts";

class MemoryCacheStore {
  values = new Map();
  metadata = new Map();

  async get(key) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    this.values.set(key, structuredClone(value));
    this.metadata.set(key, structuredClone(options.metadata || {}));
    return { modified: true, etag: key };
  }

  async getMetadata(key) {
    if (!this.values.has(key)) return null;
    return { etag: key, metadata: structuredClone(this.metadata.get(key) || {}) };
  }

  async delete(key) {
    this.values.delete(key);
    this.metadata.delete(key);
  }

  async *list() {
    yield { blobs: [...this.values.keys()].map((key) => ({ key, etag: key })), directories: [] };
  }
}

test("cache entries expire after six hours and stale reads delete their payload", async () => {
  const store = new MemoryCacheStore();
  const now = Date.parse("2026-08-30T12:00:00.000Z");
  await writeCache(store, "note", { title: "cached" }, 6, now);
  assert.deepEqual(await readFreshCache(store, "note", now + 6 * 60 * 60 * 1000 - 1), { title: "cached" });
  assert.equal(await readFreshCache(store, "note", now + 6 * 60 * 60 * 1000), null);
  assert.equal(store.values.has("peek/note"), false);
});

test("scheduled cleanup removes expired and malformed cache entries", async () => {
  const store = new MemoryCacheStore();
  const now = Date.parse("2026-08-30T12:00:00.000Z");
  await writeCache(store, "fresh", { value: 1 }, 6, now);
  await writeCache(store, "stale", { value: 2 }, 1, now - 2 * 60 * 60 * 1000);
  await store.setJSON("peek/legacy", { value: 3 });
  const result = await purgeExpiredCache(store, now);
  assert.deepEqual(result, { scanned: 3, deleted: 2, complete: true });
  assert.deepEqual([...store.values.keys()], ["peek/fresh"]);
});

test("scheduled auth cleanup rotates the first prefix each hour", () => {
  const prefixes = ["requests/", "codes/", "access/"];
  assert.deepEqual(rotatePrefixes(prefixes, 0), prefixes);
  assert.deepEqual(rotatePrefixes(prefixes, 1), ["codes/", "access/", "requests/"]);
  assert.deepEqual(rotatePrefixes(prefixes, 2), ["access/", "requests/", "codes/"]);
});
