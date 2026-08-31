import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  detectImageMime,
  downloadMediaToFile,
  extractInitialState,
  isAllowedMediaUrl,
  isAllowedNoteUrl,
  normalizePeekOptions,
  parseXhsState,
  peekXhs,
  replaceUndefinedOutsideStrings,
} from "../netlify/functions/_shared/xhs.mts";

const execFileAsync = promisify(execFile);

test("replaces undefined tokens without touching quoted text", () => {
  const input = String.raw`{"a":undefined,"text":"undefined stays","nested":{"b":undefined}}`;
  assert.equal(replaceUndefinedOutsideStrings(input), String.raw`{"a":null,"text":"undefined stays","nested":{"b":null}}`);
});

test("extracts balanced initial state even when braces occur inside strings", () => {
  const html = `<script>window.__INITIAL_STATE__ = {"text":"a } brace","value":undefined};</script>`;
  assert.deepEqual(extractInitialState(html), { text: "a } brace", value: null });
});

test("parses image note and chooses WB_DFT image", () => {
  const state = {
    noteData: {
      data: {
        noteData: {
          noteId: "abc123",
          title: "三花猫站长",
          desc: "今天去盖章",
          type: "normal",
          user: { nickname: "灯灯" },
          interactInfo: { likedCount: "18", collectedCount: "6", commentCount: "3" },
          imageList: [{
            infoList: [
              { imageScene: "CRD_WM_JPG", url: "https://sns-img-bd.xhscdn.com/low.jpg" },
              { imageScene: "WB_DFT", url: "https://sns-img-bd.xhscdn.com/high.jpg" },
            ],
          }],
          commentData: { comments: [{ content: "好可爱" }] },
        },
      },
    },
  };
  const note = parseXhsState(state, "https://www.xiaohongshu.com/explore/abc123?xsec_token=t");
  assert.equal(note.title, "三花猫站长");
  assert.equal(note.author, "灯灯");
  assert.deepEqual(note.images, ["https://sns-img-bd.xhscdn.com/high.jpg"]);
  assert.equal(note.videoUrl, null);
  assert.deepEqual(note.comments, ["好可爱"]);
});

test("upgrades allowlisted Xiaohongshu CDN image URLs to HTTPS", () => {
  const state = { noteData: { data: { noteData: {
    title: "旧协议图片",
    desc: "",
    imageList: [{ infoList: [{ imageScene: "WB_DFT", url: "http://sns-webpic-qc.xhscdn.com/a.jpg" }] }],
  } } } };
  assert.deepEqual(parseXhsState(state, "https://xhslink.cn/o/test").images, ["https://sns-webpic-qc.xhscdn.com/a.jpg"]);
});

test("prefers h264 masterUrl and supports origin video fallback", () => {
  const base = {
    noteData: { data: { noteData: {
      title: "视频",
      desc: "vlog",
      video: { media: { stream: { h264: [{ masterUrl: "https://sns-video-bd.xhscdn.com/master.mp4" }] } } },
    } } },
  };
  assert.equal(parseXhsState(base, "https://xhslink.com/a").videoUrl, "https://sns-video-bd.xhscdn.com/master.mp4");

  base.noteData.data.noteData.video = { consumer: { originVideoKey: "keys/original.mp4" } };
  assert.equal(parseXhsState(base, "https://xhslink.com/a").videoUrl, "https://sns-video-bd.xhscdn.com/keys/original.mp4");
});

test("rejects non-XHS media URLs rather than creating an open proxy", () => {
  const state = { noteData: { data: { noteData: {
    title: "bad media",
    desc: "",
    imageList: [{ url: "https://example.com/private" }],
    video: { url: "http://127.0.0.1:8080/secrets" },
  } } } };
  const note = parseXhsState(state, "https://xhslink.com/a");
  assert.deepEqual(note.images, []);
  assert.equal(note.videoUrl, null);
});

test("accepts only XHS page URLs and XHS CDN media URLs", () => {
  assert.equal(isAllowedNoteUrl("https://www.xiaohongshu.com/explore/abc?xsec_token=token"), true);
  assert.equal(isAllowedNoteUrl("http://xhslink.com/a1b2c3"), true);
  assert.equal(isAllowedNoteUrl("https://xhslink.cn/o/2jgW6v8rMT5"), true);
  assert.equal(isAllowedNoteUrl("https://xhslink.com.evil.example/a"), false);
  assert.equal(isAllowedNoteUrl("https://xhslink.cn.evil.example/a"), false);
  assert.equal(isAllowedNoteUrl("https://xhslink.com:8443/a"), false);

  assert.equal(isAllowedMediaUrl("https://sns-img-bd.xhscdn.com/image.jpg"), true);
  assert.equal(isAllowedMediaUrl("https://sns-video-bd.xhscdn.net/video.mp4"), true);
  assert.equal(isAllowedMediaUrl("https://api.xiaohongshu.com/private"), false);
  assert.equal(isAllowedMediaUrl("https://evilxhscdn.com/image.jpg"), false);
  assert.equal(isAllowedMediaUrl("http://sns-img-bd.xhscdn.com/image.jpg"), false);
});

test("collects first-screen comments stored beside note data", () => {
  const state = {
    noteData: {
      data: {
        noteData: {
          noteId: "abc123",
          title: "标题",
          desc: "正文",
          imageList: [{ url: "https://sns-img-bd.xhscdn.com/a.jpg" }],
        },
        commentData: {
          comments: [{ content: "第一条" }, { content: "第二条" }],
        },
      },
    },
  };
  assert.deepEqual(parseXhsState(state, "https://www.xiaohongshu.com/explore/abc123").comments, ["第一条", "第二条"]);
});

test("normalizes limits to 4-8 video frames and a 200 MB ceiling", () => {
  assert.deepEqual(normalizePeekOptions({ maxImages: 99, maxFrames: 99, maxVideoMb: 999 }), {
    imageMode: "blocks",
    maxImages: 12,
    maxFrames: 8,
    maxVideoMb: 200,
  });
  assert.deepEqual(normalizePeekOptions({ imageMode: "url", maxImages: -1, maxFrames: 1, maxVideoMb: 1 }), {
    imageMode: "url",
    maxImages: 1,
    maxFrames: 4,
    maxVideoMb: 10,
  });
});

test("detects safe image formats by magic bytes instead of trusting headers", () => {
  assert.equal(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
  assert.equal(detectImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectImageMime(new TextEncoder().encode("<html>not an image</html>")), null);
});

test("streams an allowlisted video to disk and enforces its byte limit", async (t) => {
  const previousFetch = globalThis.fetch;
  const chunks = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6])];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "video/mp4" } });
  const dir = await mkdtemp(join(tmpdir(), "xhs-eye-test-"));
  t.after(async () => {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const destination = join(dir, "video.mp4");
  const downloaded = await downloadMediaToFile("https://sns-video-bd.xhscdn.com/video.mp4", destination, 6, 5_000);
  assert.equal(downloaded.bytesWritten, 6);
  assert.deepEqual(await readFile(destination), Buffer.from([1, 2, 3, 4, 5, 6]));
  await assert.rejects(
    downloadMediaToFile("https://sns-video-bd.xhscdn.com/video.mp4", join(dir, "too-big.mp4"), 5, 5_000),
    /超过安全大小限制/,
  );
});

test("video notes return four ordered frames before cover images", async (t) => {
  const ffmpeg = join(process.cwd(), "netlify", "functions", "_bin", "ffmpeg");
  assert.equal(existsSync(ffmpeg), true, "prepared ffmpeg binary is required");
  const dir = await mkdtemp(join(tmpdir(), "xhs-eye-frames-test-"));
  const videoPath = join(dir, "video.mp4");
  const coverPath = join(dir, "cover.jpg");
  await execFileAsync(ffmpeg, [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
    "-t", "2", "-pix_fmt", "yuv420p", videoPath,
  ]);
  await execFileAsync(ffmpeg, ["-y", "-v", "error", "-i", videoPath, "-frames:v", "1", coverPath]);
  const video = await readFile(videoPath);
  const cover = await readFile(coverPath);
  const imageList = Array.from({ length: 12 }, (_, index) => ({ url: `https://sns-img-bd.xhscdn.com/cover-${index}.jpg` }));
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: { noteData: {
    noteId: "video-note",
    title: "video",
    desc: "ordered frames",
    imageList,
    video: { media: { stream: { h264: [{ masterUrl: "https://sns-video-bd.xhscdn.com/video.mp4" }] } } },
  } } } })};</script>`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "xhslink.com") return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    if (url.pathname.endsWith(".mp4")) return new Response(video, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(video.byteLength) } });
    return new Response(cover, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(cover.byteLength) } });
  };
  t.after(async () => {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  });

  const result = await peekXhs("https://xhslink.com/example", { maxFrames: 4, maxImages: 12, maxVideoMb: 10 });
  assert.equal(result.media.length, 12);
  assert.deepEqual(result.media.slice(0, 4).map((item) => item.label), [
    "视频抽帧 1/4",
    "视频抽帧 2/4",
    "视频抽帧 3/4",
    "视频抽帧 4/4",
  ]);
  assert.ok(result.media.slice(0, 4).every((item) => item.mimeType === "image/jpeg" && item.data.length > 0));
});

test("a request-level deadline stops note work before network access", async (t) => {
  const previousFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not fetch");
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  await assert.rejects(peekXhs("https://xhslink.com/example", {}, Date.now() - 1), /运行时限/);
  assert.equal(called, false);
});
