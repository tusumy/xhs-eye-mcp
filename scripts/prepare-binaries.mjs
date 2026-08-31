import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ffprobeStatic from "@derhuerst/ffprobe-static";
import ffmpegStatic from "ffmpeg-static";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "netlify", "functions", "_bin");
const ffmpegPath = typeof ffmpegStatic === "string" ? ffmpegStatic : ffmpegStatic?.default;
const ffprobePath = typeof ffprobeStatic === "string" ? ffprobeStatic : ffprobeStatic?.default;

if (!ffmpegPath || !ffprobePath) throw new Error("ffmpeg-static or ffprobe-static did not provide a binary path");

await mkdir(destination, { recursive: true });
await Promise.all([
  copyFile(ffmpegPath, join(destination, "ffmpeg")),
  copyFile(ffprobePath, join(destination, "ffprobe")),
  copyFile(join(root, "node_modules", "ffmpeg-static", "ffmpeg.LICENSE"), join(destination, "ffmpeg.LICENSE")),
  copyFile(join(root, "node_modules", "ffmpeg-static", "ffmpeg.README"), join(destination, "ffmpeg.README")),
  copyFile(join(root, "node_modules", "@derhuerst", "ffprobe-static", "ffprobe.LICENSE"), join(destination, "ffprobe.LICENSE")),
  copyFile(join(root, "node_modules", "@derhuerst", "ffprobe-static", "ffprobe.README"), join(destination, "ffprobe.README")),
]);
await Promise.all([
  chmod(join(destination, "ffmpeg"), 0o755),
  chmod(join(destination, "ffprobe"), 0o755),
]);
