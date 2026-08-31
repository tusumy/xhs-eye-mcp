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
    throw new Error("链接格式不对，请使用小红书分享链接。");
  }
  if (url.username || url.password || url.port) throw new Error("链接不能包含账号信息或自定义端口。");
  if (kind === "media" && url.protocol !== "https:") throw new Error("媒体链接必须使用 HTTPS。");
  if (kind === "note" && url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只支持 HTTP(S) 链接。");
  const allowed = kind === "note" ? isNoteHost(url.hostname) : isMediaHost(url.hostname);
  if (!allowed) throw new Error(kind === "note" ? "这不是受支持的小红书链接。" : "媒体地址不属于小红书 CDN。");
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
  if (!response.ok) throw new Error(`小红书返回了 HTTP ${response.status}`);
  const announced = Number(response.headers.get("content-length") || 0);
  if (announced > limit) throw new Error("返回内容超过安全大小限制。");
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
      throw new Error("返回内容超过安全大小限制。");
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
    if (remaining <= 0) throw new Error("小红书页面读取超时。");
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
    if (!location) throw new Error("小红书跳转缺少目标地址。");
    current = assertHttpUrl(String(new URL(location, current)), "note");
  }
  throw new Error("小红书链接跳转次数过多。");
}

function extractBalancedObject(source: string, start: number): string {
  const brace = source.indexOf("{", start);
  if (brace < 0) throw new Error("页面里没有找到笔记数据。");
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
  throw new Error("笔记数据不完整。");
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
  if (index < 0) throw new Error("页面里没有找到 __INITIAL_STATE__，链接可能已失效或需要登录。");
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
  throw new Error("找到了页面数据，但没认出笔记结构；小红书页面结构可能变了。");
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
    if (remaining <= 0) throw new Error("媒体下载超时。");
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": MOBILE_UA, accept: "image/avif,image/webp,image/jpeg,image/*,video/mp4,*/*;q=0.5" },
      signal: AbortSignal.timeout(remaining),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("媒体跳转缺少目标地址。");
      current = assertHttpUrl(String(new URL(location, current)), "media");
      continue;
    }
    const bytes = await readLimited(response, limit);
    return { bytes, mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0] };
  }
  throw new Error("媒体链接跳转次数过多。");
}

async function writeLimited(response: Response, destination: string, limit: number): Promise<number> {
  if (!response.ok) throw new Error(`小红书返回了 HTTP ${response.status}`);
  const announced = Number(response.headers.get("content-length") || 0);
  if (announced > limit) throw new Error("返回内容超过安全大小限制。");
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
        throw new Error("返回内容超过安全大小限制。");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error("视频暂存写入失败。");
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
    if (remaining <= 0) throw new Error("媒体下载超时。");
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": MOBILE_UA, accept: "video/mp4,video/*,*/*;q=0.5" },
      signal: AbortSignal.timeout(remaining),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("媒体跳转缺少目标地址。");
      current = assertHttpUrl(String(new URL(location, current)), "media");
      continue;
    }
    const bytesWritten = await writeLimited(response, destination, limit);
    return {
      bytesWritten,
      mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0],
    };
  }
  throw new Error("媒体链接跳转次数过多。");
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
    if (!detected) throw new Error("响应内容不是受支持的图片。");
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
  if (!ffmpegPath || !ffprobePath) throw new Error("服务器没有安装 ffmpeg，已退回封面和文字。");
  const dir = await mkdtemp(join(tmpdir(), "xhs-eye-"));
  try {
    const beforeDownload = deadline - Date.now();
    if (beforeDownload < 12_000) throw new Error("本次响应剩余时间不足，已跳过视频抽帧。");
    const videoPath = join(dir, "video.mp4");
    await downloadMediaToFile(videoUrlValue, videoPath, maxVideoMb * 1024 * 1024, Math.min(34_000, beforeDownload - 8_000));
    const probeTimeout = Math.min(6_000, deadline - Date.now() - 5_000);
    if (probeTimeout < 1_000) throw new Error("本次响应剩余时间不足，已跳过视频抽帧。");
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { timeout: probeTimeout });
    const duration = Number(String(stdout).trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("读不到视频时长。");
    const count = Math.max(4, Math.min(maxFrames, Math.ceil(duration / 8)));
    const framePattern = join(dir, "frame-%02d.jpg");
    const frameTimeout = deadline - Date.now() - 1_000;
    if (frameTimeout < 2_000) throw new Error("本次响应剩余时间不足，已跳过视频抽帧。");
    await execFileAsync(ffmpegPath, [
      "-y", "-v", "error", "-i", videoPath,
      "-vf", `fps=${count}/${duration},scale='min(640,iw)':-2`,
      "-frames:v", String(count), "-q:v", "10", framePattern,
    ], { timeout: frameTimeout, maxBuffer: 2 * 1024 * 1024 });
    let prefix = "frame";
    let files = (await readdir(dir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort().slice(0, count);
    if (files.length < 4) throw new Error("视频不足以生成至少 4 张抽帧。");

    const readBlocks = async () => await Promise.all(files.map(async (name) => ({
      mimeType: "image/jpeg",
      data: (await readFile(join(dir, name))).toString("base64"),
      label: "",
    })));
    let blocks = await readBlocks();
    for (const [width, quality] of [[480, 14], [320, 18]] as const) {
      if (blocks.reduce((total, frame) => total + frame.data.length, 0) <= VIDEO_FRAME_BASE64_LIMIT) break;
      const remaining = deadline - Date.now() - 500;
      if (remaining < 1_000) throw new Error("视频抽帧接近响应上限，但已没有足够时间压缩。");
      const outputPrefix = `frame-${width}`;
      await execFileAsync(ffmpegPath, [
        "-y", "-v", "error", "-framerate", "1", "-i", join(dir, `${prefix}-%02d.jpg`),
        "-vf", `scale='min(${width},iw)':-2`, "-frames:v", String(files.length), "-q:v", String(quality),
        join(dir, `${outputPrefix}-%02d.jpg`),
      ], { timeout: remaining, maxBuffer: 2 * 1024 * 1024 });
      prefix = outputPrefix;
      files = (await readdir(dir)).filter((name) => new RegExp(`^${outputPrefix}-\\d+\\.jpg$`).test(name)).sort().slice(0, count);
      if (files.length < 4) throw new Error("视频帧压缩后数量不足。");
      blocks = await readBlocks();
    }
    if (blocks.reduce((total, frame) => total + frame.data.length, 0) > VIDEO_FRAME_BASE64_LIMIT) throw new Error("视频抽帧超过单次响应图片总量限制。");
    return blocks.map((frame, index) => ({ ...frame, label: `视频抽帧 ${index + 1}/${blocks.length}` }));
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
  if (deadline <= Date.now()) throw new Error("本次请求已超过运行时限。");
  const note = await fetchXhsNote(rawUrl, deadline);
  const media: PeekResult["media"] = [];
  const warnings: string[] = [];
  let encodedBytes = 0;
  const appendMedia = (item: { mimeType: string; data: string; label: string }): boolean => {
    if (media.length >= MAX_RESPONSE_IMAGES) {
      warnings.push("已达到单次响应图片数量上限，剩余图片保留为直链。");
      return false;
    }
    if (encodedBytes + item.data.length > MCP_MEDIA_BASE64_LIMIT) {
      warnings.push("图片内容接近客户端响应上限，剩余图片已改用直链保留。");
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
          if (!appendMedia(frame)) throw new Error("视频抽帧超过单次响应图片总量限制。");
        }
      } catch (error) {
        warnings.push(`视频抽帧失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
    for (const [index, url] of note.images.slice(0, maxImages).entries()) {
      try {
        const remaining = deadline - Date.now();
        if (remaining < 3_000) {
          warnings.push("本次响应接近运行时限，剩余配图已保留为直链。");
          break;
        }
        const fetched = await fetchMedia(url, IMAGE_LIMIT, Math.min(8_000, Math.max(1_000, remaining - 1_500)));
        const item = await normalizeImage(fetched.bytes, fetched.mimeType, Math.min(8_000, Math.max(1_000, deadline - Date.now() - 500)));
        if (!item.mimeType.startsWith("image/")) throw new Error("不是图片响应");
        if (!appendMedia({ mimeType: item.mimeType, data: Buffer.from(item.bytes).toString("base64"), label: `配图 ${index + 1}/${Math.min(note.images.length, maxImages)}` })) break;
      } catch (error) {
        warnings.push(`第 ${index + 1} 张配图下载失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }
  }
  return { note, media, warnings };
}

export function noteSummary(note: XhsNote, warnings: string[] = []): string {
  const lines = [
    `标题：${note.title || "（无标题）"}`,
    `作者：${note.author || "（未知）"}`,
    `类型：${note.videoUrl ? "视频笔记" : "图文笔记"}`,
    `正文：${note.description || "（无正文）"}`,
    `互动：点赞 ${note.stats.liked ?? "?"}｜收藏 ${note.stats.collected ?? "?"}｜评论 ${note.stats.comments ?? "?"}｜分享 ${note.stats.shared ?? "?"}`,
    `原链接：${note.canonicalUrl}`,
  ];
  if (note.comments.length) lines.push(`首屏评论：\n${note.comments.map((text, index) => `${index + 1}. ${text}`).join("\n")}`);
  if (warnings.length) lines.push(`读取提示：\n${warnings.map((text) => `- ${text}`).join("\n")}`);
  return lines.join("\n");
}
