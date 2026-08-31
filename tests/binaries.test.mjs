import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ffprobePath from "@derhuerst/ffprobe-static";
import ffmpegPath from "ffmpeg-static";

function version(binary, name) {
  assert.ok(binary, `${name} path is missing`);
  const result = spawnSync(binary, ["-version"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || `${name} did not exit successfully`);
  assert.match(result.stdout, new RegExp(`^${name} version`, "i"));
}

test("bundled ffmpeg and ffprobe binaries are executable", () => {
  version(ffmpegPath, "ffmpeg");
  version(ffprobePath, "ffprobe");
});
