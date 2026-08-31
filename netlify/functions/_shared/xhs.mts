import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) || null;
}

const ffmpegPath = firstExisting([
  join(moduleDirectory, "_bin", "ffmpeg"),
  join(moduleDirectory, "..", "_bin", "ffmpeg"),
  join(process.cwd(), "netlify", "functions", "_bin", "ffmpeg"),
]);
const ffprobePath = firstExisting([
  join(moduleDirectory, "_bin", "ffprobe"),
  join(moduleDirectory, "..", "_bin", "ffprobe"),
  join(process.cwd(), "netlify", "functions", "_bin", "ffprobe"),
]);

export const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const NOTE_HOSTS = new Set(["xhslink.com", "www.xhslink.com", "xiaohongshu.com", "www.xiaohongshu.com", "m.xiaohongshu.com"]);
const MEDIA_ROOT_HOSTS = new Set(["xhscdn.com", "xhscdn.net"]);
const MEDIA_HOST_SUFFIXES = [".xhscdn.com", ".xhscdn.net"];
const HTML_LIMIT = 8 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const MCP_MEDIA_BASE64_LIMIT = 4_200_000;
const VIDEO_FRAME_BASE64_LIMIT = 3_800_000;
const MAX_RESPONSE_IMAGES = 12;
const PEEK_BUDGET_MS = 52_000;

export type XhsNote = {
  canonicalUrl: string;
  id: string | null;
  title: string;
  description: string;
  author: string;
  type: string;
  images: string[];
  videoUrl: string | null;
  stats: Record<string, string | number | null>;
  comments: string[];
};

export type PeekOptions = {
  imageMode?: "blocks" | "url";
  maxImages?: number;
  maxFrames?: number;
  maxVideoMb?: number;
};

export type PeekResult = {
  note: XhsNote;
  media: Array<{ mimeType: string; data: string; label: string }>;
  warnings: string[];
};

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isNoteHost(hostname: string): boolean {
  return NOTE_HOSTS.has(normalizeHost(hostname));
}

function isMediaHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return MEDIA_ROOT_HOSTS.has(host) || MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function assertHttpUrl(raw: string, kind: "note" | "media"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("é¾æ¥æ ¼å¼ä¸å¯¹ï¼è¯·ä½¿ç¨å°çº¢ä¹¦åäº«é¾æ¥ã");
  }
  if (url.username || url.password || url.port) throw new Error("é¾æ¥ä¸è½åå«è´¦å·ä¿¡æ¯æèªå®ä¹ç«¯å£ã");
  if (kind === "media" && url.protocol !== "https:") throw new Error("åªä½é¾æ¥å¿é¡»ä½¿ç¨ HTTPSã");
  if (kind === "note" && url.protocol !== "https:" && url.protocol !== "http:") throw new Error("åªæ¯æ HTTP(S) é¾æ¥ã");
  const allowed = kind === "note" ? isNoteHost(url.hostname) : isMediaHost(url.hostname);
  if (!allowed) throw new Error(kind === "note" ? "è¿ä¸æ¯åæ¯æçå°çº¢ä¹¦é¾æ¥ã" : "åªä½å°åä¸å±äºå°çº¢ä¹¦ CDNã");
  return url;
}

export function isAllowedNoteUrl(raw: string): boolean {
  try {
    assertHttpUrl(raw, "note");
    return true;
  } catch {
    return false;
  }
}

export function isAllowedMediaUrl(raw: string): boolean {
  try {
    assertHttpUrl(raw, "media");
    return true;
  } catch {
    return false;
  }
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`å°çº¢ä¹¦è¿åäº HTTP ${response.status}`);
  const announced = Number(response.headers.get("content-length") || 0);
  if (announced > limit) throw new Error("è¿ååå®¹è¶è¿å®å¨å¤§å°éå¶ã");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("è¿ååå®¹è¶è¿å®å¨å¤§å°éå¶ã");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchFollowingAllowedRedirects(rawUrl: string, deadline: number): Promise<{ response: Response; finalUrl: string }> {
  let current = assertHttpUrl(rawUrl, "note");
  for (let hop = 0; hop < 6; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("å°çº¢ä¹¦é¡µé¢è¯»åè¶æ¶ã");
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": MOBILE_UA,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      },
      signal: AbortSignal.timeout(Math.min(12_000, remaining)),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: String(current) };
    const location = response.headers.get("location");
    if (!location) throw new Error("å°çº¢ä¹¦è·³è½¬ç¼ºå°ç®æ å°åã");
    current = assertHttpUrl(String(new URL(location, current)), "note");
  }
  throw new Error("å°çº¢ä¹¦é¾æ¥è·³è½¬æ¬¡æ°è¿å¤ã");
}

function extractBalancedObject(source: string, start: number): string {
  const brace = source.indexOf("{", start);
  if (brace < 0) throw new Error("é¡µé¢éæ²¡ææ¾å°ç¬è®°æ°æ®ã");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace, i + 1);
    }
  }
  throw new Error("ç¬è®°æ°æ®ä¸å®æ´ã");
}

export function replaceUndefinedOutsideStrings(source: string): string {
  let out = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (source.startsWith("undefined", i)) {
      const before = i === 0 ? "" : source[i - 1];
      const after = source[i + 9] || "";
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
        out += "null";
        i += 9;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function extractInitialState(html: string): unknown {
  const markers = ["window.__INITIAL_STATE__", "__INITIAL_STATE__"];
  let index = -1;
  for (const marker of markers) {
    index = html.indexOf(marker);
    if (index >= 0) break;
  }
  if (index < 0) throw new Error("é¡µé¢éæ²¡ææ¾å° __INITIAL_STATE__ï¼é¾æ¥å¯è½å·²å¤±ææéè¦ç»å½ã");
  const raw = extractBalancedObject(html, index);
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(replaceUndefinedOutsideStrings(raw));
  }
}

function atPath(root: any, path: string[]): any {
  let value = root;
  for (const key of path) value = value?.[key];
  return value;
}

function looksLikeNote(value: any): boolean {
  return Boolean(value && typeof value === "object" && (
    Array.isArray(value.imageList) || value.video || value.noteId || value.note_id
  ) && (value.title !== undefined || value.desc !== undefined || value.description !== undefined));
}

function findNote(root: any): any {
  const candidates = [
    ["noteData", "data", "noteData"],
    ["noteData", "data", "noteData", "note"],
    ["normalNotePreloadData", "data", "noteData"],
    ["normalNotePreloadData", "noteData"],
  ];
  for (const path of candidates) {
    const value = atPath(root, path);
    if (looksLikeNote(value)) return value;
    if (Array.isArray(value?.noteList) && looksLikeNote(value.noteList[0])) return value.noteList[0];
  }
  const seen = new Set<any>();
  const queue: Array<{ value: any; depth: number }> = [{ value: root, depth: 0 }];
  while (queue.length) {
    const item = queue.shift()!;
    if (!item.value || typeof item.value !== "object" || seen.has(item.value) || item.depth > 9) continue;
    seen.add(item.value);
    if (looksLikeNote(item.value)) return item.value;
    const children = Array.isArray(item.value) ? item.value : Object.values(item.value);
    for (const child of children) queue.push({ value: child, depth: item.depth + 1 });
  }
  throw new Error("æ¾å°äºé¡µé¢æ°æ®ï¼ä½æ²¡è®¤åºç¬è®°ç»æï¼å°çº¢ä¹¦é¡µé¢ç»æå¯è½åäºã");
}

function stringValue(...values: any[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  try {
    return String(assertHttpUrl(normalized, "media"));
  } catch {
    return null;
  }
}

function imageUrl(image: any): string | null {
  const info = Array.isArray(image?.infoList) ? image.infoList : [];
  const preferred = info.find((entry: any) => entry?.imageScene === "WB_DFT") || info[0];
  const candidates = [
    preferred?.url,
    preferred?.urlDefault,
    image?.urlDefault,
    image?.url,
    image?.urlPre,
    image?.urlWp,
    image?.traceId && `https://sns-img-bd.xhscdn.com/${image.traceId}`,
  ];
  for (const candidate of candidates) {
    const url = safeMediaUrl(candidate);
    if (url) return url;
  }
  return null;
}

function videoUrl(note: any): string | null {
  const video = note?.video;
  const streams = video?.media?.stream || {};
  const codecs = ["h264", "h265", "av1"];
  for (const codec of codecs) {
    for (const stream of Array.isArray(streams?.[codec]) ? streams[codec] : []) {
      for (const candidate of [stream?.masterUrl, ...(Array.isArray(stream?.backupUrls) ? stream.backupUrls : [])]) {
        const url = safeMediaUrl(candidate);
        if (url) return url;
      }
    }
  }
  const key = stringValue(video?.consumer?.originVideoKey, video?.originVideoKey);
  if (key && !key.includes("..") && !key.includes("://")) {
    const url = safeMediaUrl(`https://sns-video-bd.xhscdn.com/${key.replace(/^\/+/, "")}`);
    if (url) return url;
  }
  return safeMediaUrl(video?.url);
}

function appendComments(list: unknown, out: string[]): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const text = stringValue(item?.content, item?.text, item?.desc);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 10) return;
  }
}

function collectComments(note: any, state: any): string[] {
  const roots = [note?.comments, note?.commentList, note?.commentData?.comments, note?.commentInfo?.comments];
  const out: string[] = [];
  for (const list of roots) appendComments(list, out);
  if (out.length >= 10) return out;

  const seen = new Set<any>();
  const queue: Array<{ key: string; value: any; depth: number }> = [{ key: "", value: state, depth: 0 }];
  while (queue.length && seen.size < 5_000 && out.length < 10) {
    const current = queue.shift()!;
    if (!current.value || typeof current.value !== "object" || seen.has(current.value) || current.depth > 9) continue;
    seen.add(current.value);
    if (/comment/i.test(current.key) && Array.isArray(current.value)) appendComments(current.value, out);
    if (out.length >= 10) break;
    for (const [key, value] of Object.entries(current.value)) {
      if (value && typeof value === "object") queue.push({ key, value, depth: current.depth + 1 });
    }
  }
  return out;
}

export function parseXhsState(state: any, canonicalUrl: string): XhsNote {
  const note = findNote(state);
  const author = note?.user || note?.author || note?.userInfo || {};
  const interact = note?.interactInfo || note?.interact_info || {};
  const imageCandidates: any[] = Array.isArray(note?.imageList) ? note.imageList : Array.isArray(note?.images) ? note.images : [];
  const images: string[] = imageCandidates
    .map(imageUrl)
    .filter((value: string | null): value is string => Boolean(value));
  return {
    canonicalUrl,
    id: stringValue(note?.noteId, note?.note_id, note?.id) || null,
    title: stringValue(note?.title),
    description: stringValue(note?.desc, note?.description, note?.content),
    author: stringValue(author?.nickname, author?.nickName, author?.name),
    type: stringValue(note?.type, note?.noteType) || (note?.video ? "video" : "image"),
    images: [...new Set(images)],
    videoUrl: videoUrl(note),
    stats: {
      liked: interact?.likedCount ?? interact?.liked_count ?? null,
      collected: interact?.collectedCount ?? interact?.collected_count ?? null,
      comments: interact?.commentCount ?? interact?.comment_count ?? null,
      shared: interact?.shareCount ?? interact?.share_count ?? null,
    },
    comments: collectComments(note, state),
  };
}

export async function fetchXhsNote(rawUrl: string, deadline = Date.now() + PEEK_BUDGET_MS): Promise<XhsNote> {
  const { response, finalUrl } = await fetchFollowingAllowedRedirects(rawUrl.trim(), deadline);
  const bytes = await readLimited(response, HTML_LIMIT);
  const html = new TextDecoder().decode(bytes);
  return parseXhsState(extractInitialState(html), finalUrl);
}

async function fetchMedia(rawUrl: string, limit: number, timeoutMs = 12_000): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let current = assertHttpUrl(rawUrl, "media");
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  for (let hop = 0; hop < 5; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("åªä½ä¸è½½è¶æ¶ã");
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": MOBILE_UA, accept: "image/avif,image/webp,image/jpeg,image/*,video/mp4,*/*;q=0.5" },
      signal: AbortSignal.timeout(remaining),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("åªä½è·³è½¬ç¼ºå°ç®æ å°åã");
      current = assertHttpUrl(String(new URL(location, current)), "media");
      continue;
    }
    const bytes = await readLimited(response, limit);
    return { bytes, mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0] };
  }
  throw new Error("åªä½é¾æ¥è·³è½¬æ¬¡æ°è¿å¤ã");
}

async function writeLimited(response: Response, destination: string, limit: number): Promise<number> {
  if (!response.ok) throw new Error(`å°çº¢ä¹¦è¿åäº HTTP ${response.status}`);
  const announced = Number(response.headers.get("content-length") || 0);
  if (announced > limit) throw new Error("è¿ååå®¹è¶è¿å®å¨å¤§å°éå¶ã");
  const file = await open(destination, "wx");
  let total = 0;
  try {
    if (!response.body) return 0;
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("è¿ååå®¹è¶è¿å®å¨å¤§å°éå¶ã");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error("è§é¢æå­åå¥å¤±è´¥ã");
        offset += bytesWritten;
      }
    }
    return total;
  } finally {
    await file.close();
  }
}

export async function downloadMediaToFile(rawUrl: string, destination: string, limit: number, timeoutMs = 32_000): Promise<{ bytesWritten: number; mimeType: string }> {
  let current = assertHttpUrl(rawUrl, "media");
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  for (let hop = 0; hop < 5; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("åªä½ä¸è½½è¶æ¶ã");
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": MOBILE_UA, accept: "video/mp4,video/*,*/*;q=0.5" },
      signal: AbortSignal.timeout(remaining),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("åªä½è·³è½¬ç¼ºå°ç®æ å°åã");
      current = assertHttpUrl(String(new URL(location, current)), "media");
      continue;
    }
    const bytesWritten = await writeLimited(response, destination, limit);
    return {
      bytesWritten,
      mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0],
    };
  }
  throw new Error("åªä½é¾æ¥è·³è½¬æ¬¡æ°è¿å¤ã");
}

export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp" && ["avif", "avis"].includes(new TextDecoder().decode(bytes.slice(8, 12)))) return "image/avif";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6)))) return "image/gif";
  return null;
}

async function normalizeImage(bytes: Uint8Array, _mimeType: string, timeoutMs = 8_000): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const detected = detectImageMime(bytes);
  if (detected === "image/jpeg" && bytes.byteLength <= 360_000) return { bytes, mimeType: detected };
  if (!ffmpegPath) {
    if (!detected) throw new Error("ååºåå®¹ä¸æ¯åæ¯æçå¾çã");
    return { bytes, mimeType: detected };
  }
  const dir = await mkdtemp(join(tmpdir(), "xhs-eye-image-"));
  try {
    const input = join(dir, "input");
    const output = join(dir, "output.jpg");
    await writeFile(input, bytes);
    await execFileAsync(ffmpegPath, [
      "-y", "-v", "error", "-i", input,
      "-vf", "scale='min(960,iw)':-2", "-frames:v", "1", "-q:v", "7", output,
    ], { timeout: Math.max(1_000, timeoutMs), maxBuffer: 1024 * 1024 });
    return { bytes: await readFile(output), mimeType: "image/jpeg" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function extractFrames(videoUrlValue: string, maxFrames: number, maxVideoMb: number, deadline: number): Promise<Array<{ mimeType: string; data: string; label: string }>> {
  if (!ffmpegPath || !ffprobePath) throw new Error("æå¡å¨æ²¡æå®è£ ffmpegï¼å·²éåå°é¢åæå­ã");
  const dir = await mkdtemp(join(tmpdir(), "xhs-eye-"));
  try {
    const beforeDownload = deadline - Date.now();
    if (beforeDownload < 12_000) throw new Error("æ¬æ¬¡ååºå©ä½æ¶é´ä¸è¶³ï¼å·²è·³è¿è§é¢æ½å¸§ã");
    const videoPath = join(dir, "video.mp4");
    await downloadMediaToFile(videoUrlValue, videoPath, maxVideoMb * 1024 * 1024, Math.min(34_000, beforeDownload - 8_000));
    const probeTimeout = Math.min(6_000, deadline - Date.now() - 5_000);
    if (probeTimeout < 1_000) throw new Error("æ¬æ¬¡ååºå©ä½æ¶é´ä¸è¶³ï¼å·²è·³è¿è§é¢æ½å¸§ã");
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { timeout: probeTimeout });
    const duration = Number(String(stdout).trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("è¯»ä¸å°è§é¢æ¶é¿ã");
    const count = Math.max(4, Math.min(maxFrames, Math.ceil(duration / 8)));
    const framePattern = join(dir, "frame-%02d.jpg");
    const frameTimeout = deadline - Date.now() - 1_000;
    if (frameTimeout < 2_000) throw new Error("æ¬æ¬¡ååºå©ä½æ¶é´ä¸è¶³ï¼å·²è·³è¿è§é¢æ½å¸§ã");
    await execFileAsync(ffmpegPath, [
      "-y", "-v", "error", "-i", videoPath,
      "-vf", `fps=${count}/${duration},scale='min(640,iw)':-2`,
      "-frames:v", String(count), "-q:v", "10", framePattern,
    ], { timeout: frameTimeout, maxBuffer: 2 * 1024 * 1024 });
    let prefix = "frame";
    let files = (await readdir(dir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort().slice(0, count);
    if (files.length < 4) throw new Error("è§é¢ä¸è¶³ä»¥çæè³å° 4 å¼ æ½å¸§ã");

    const readBlocks = async () => await Promise.all(files.map(async (name) => ({
      mimeType: "image/jpeg",
      data: (await readFile(join(dir, name))).toString("base64"),
      label: "",
    })));
    let blocks = await readBlocks();
    for (const [width, quality] of [[480, 14], [320, 18]] as const) {
      if (blocks.reduce((total, frame) => total + frame.data.length, 0) <= VIDEO_FRAME_BASE64_LIMIT) break;
      const remaining = deadline - Date.now() - 500;
      if (remaining < 1_000) throw new Error("è§é¢æ½å¸§æ¥è¿ååºä¸éï¼ä½å·²æ²¡æè¶³å¤æ¶é´åç¼©ã");
      const outputPrefix = `frame-${width}`;
      await execFileAsync(ffmpegPath, [
        "-y", "-v", "error", "-framerate", "1", "-i", join(dir, `${prefix}-%02d.jpg`),
        "-vf", `scale='min(${width},iw)':-2`, "-frames:v", String(files.length), "-q:v", String(quality),
        join(dir, `${outputPrefix}-%02d.jpg`),
      ], { timeout: remaining, maxBuffer: 2 * 1024 * 1024 });
      prefix = outputPrefix;
      files = (await readdir(dir)).filter((name) => new RegExp(`^${outputPrefix}-\\d+\\.jpg$`).test(name)).sort().slice(0, count);
      if (files.length < 4) throw new Error("è§é¢å¸§åç¼©åæ°éä¸è¶³ã");
      blocks = await readBlocks();
    }
    if (blocks.reduce((total, frame) => total + frame.data.length, 0) > VIDEO_FRAME_BASE64_LIMIT) throw new Error("è§é¢æ½å¸§è¶è¿åæ¬¡ååºå¾çæ»ééå¶ã");
    return blocks.map((frame, index) => ({ ...frame, label: `è§é¢æ½å¸§ ${index + 1}/${blocks.length}` }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function clampedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(minimum, Math.min(number, maximum));
}

export function normalizePeekOptions(options: PeekOptions = {}): Required<PeekOptions> {
  return {
    imageMode: options.imageMode === "url" ? "url" : "blocks",
    maxImages: clampedNumber(options.maxImages, 9, 1, 12),
    maxFrames: clampedNumber(options.maxFrames, 8, 4, 8),
    maxVideoMb: clampedNumber(options.maxVideoMb, 200, 10, 200),
  };
}

export async function peekXhs(rawUrl: string, options: PeekOptions = {}, requestDeadline = Date.now() + PEEK_BUDGET_MS): Promise<PeekResult> {
  const { imageMode, maxImages, maxFrames, maxVideoMb } = normalizePeekOptions(options);
  const deadline = Math.min(requestDeadline, Date.now() + PEEK_BUDGET_MS);
  if (deadline <= Date.now()) throw new Error("æ¬æ¬¡è¯·æ±å·²è¶è¿è¿è¡æ¶éã");
  const note = await fetchXhsNote(rawUrl, deadline);
  const media: PeekResult["media"] = [];
  const warnings: string[] = [];
  let encodedBytes = 0;
  const appendMedia = (item: { mimeType: string; data: string; label: string }): boolean => {
    if (media.length >= MAX_RESPONSE_IMAGES) {
      warnings.push("å·²è¾¾å°åæ¬¡ååºå¾çæ°éä¸éï¼å©ä½å¾çä¿çä¸ºç´é¾ã");
      return false;
    }
    if (encodedBytes + item.data.length > MCP_MEDIA_BASE64_LIMIT) {
      warnings.push("å¾çåå®¹æ¥è¿å®¢æ·ç«¯ååºä¸éï¼å©ä½å¾çå·²æ¹ç¨ç´é¾ä¿çã");
      return false;
    }
    media.push(item);
    encodedBytes += item.data.length;
    return true;
  };
  if (imageMode === "blocks") {
    if (note.videoUrl) {
      try {
        const frames = await extractFrames(note.videoUrl, maxFrames, maxVideoMb, deadline);
        for (const frame of frames) {
          if (!appendMedia(frame)) throw new Error("è§é¢æ½å¸§è¶è¿åæ¬¡ååºå¾çæ»ééå¶ã");
        }
      } catch (error) {
        warnings.push(`è§é¢æ½å¸§å¤±è´¥ï¼${error instanceof Error ? error.message : "æªç¥éè¯¯"}`);
      }
    }
    for (const [index, url] of note.images.slice(0, maxImages).entries()) {
      try {
        const remaining = deadline - Date.now();
        if (remaining < 3_000) {
          warnings.push("æ¬æ¬¡ååºæ¥è¿è¿è¡æ¶éï¼å©ä½éå¾å·²ä¿çä¸ºç´é¾ã");
          break;
        }
        const fetched = await fetchMedia(url, IMAGE_LIMIT, Math.min(8_000, Math.max(1_000, remaining - 1_500)));
        const item = await normalizeImage(fetched.bytes, fetched.mimeType, Math.min(8_000, Math.max(1_000, deadline - Date.now() - 500)));
        if (!item.mimeType.startsWith("image/")) throw new Error("ä¸æ¯å¾çååº");
        if (!appendMedia({ mimeType: item.mimeType, data: Buffer.from(item.bytes).toString("base64"), label: `éå¾ ${index + 1}/${Math.min(note.images.length, maxImages)}` })) break;
      } catch (error) {
        warnings.push(`ç¬¬ ${index + 1} å¼ éå¾ä¸è½½å¤±è´¥ï¼${error instanceof Error ? error.message : "æªç¥éè¯¯"}`);
      }
    }
  }
  return { note, media, warnings };
}

export function noteSummary(note: XhsNote, warnings: string[] = []): string {
  const lines = [
    `æ é¢ï¼${note.title || "ï¼æ æ é¢ï¼"}`,
    `ä½èï¼${note.author || "ï¼æªç¥ï¼"}`,
    `ç±»åï¼${note.videoUrl ? "è§é¢ç¬è®°" : "å¾æç¬è®°"}`,
    `æ­£æï¼${note.description || "ï¼æ æ­£æï¼"}`,
    `äºå¨ï¼ç¹èµ ${note.stats.liked ?? "?"}ï½æ¶è ${note.stats.collected ?? "?"}ï½è¯è®º ${note.stats.comments ?? "?"}ï½åäº« ${note.stats.shared ?? "?"}`,
    `åé¾æ¥ï¼${note.canonicalUrl}`,
  ];
  if (note.comments.length) lines.push(`é¦å±è¯è®ºï¼\n${note.comments.map((text, index) => `${index + 1}. ${text}`).join("\n")}`);
  if (warnings.length) lines.push(`è¯»åæç¤ºï¼\n${warnings.map((text) => `- ${text}`).join("\n")}`);
  return lines.join("\n");
}
