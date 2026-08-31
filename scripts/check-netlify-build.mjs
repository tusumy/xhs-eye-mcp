import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const output = await mkdtemp(join(tmpdir(), "xhs-eye-netlify-check-"));

try {
  const mcpBundle = join(output, "mcp.mjs");
  const cleanupBundle = join(output, "cache-cleanup.mjs");
  for (const [entryPoint, outfile] of [
    [join(root, "netlify", "functions", "mcp.mts"), mcpBundle],
    [join(root, "netlify", "functions", "cache-cleanup.mts"), cleanupBundle],
  ]) {
    await build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    await import(`${pathToFileURL(outfile)}?check=${Date.now()}`);
  }

  const binaryDirectory = join(output, "netlify", "functions", "_bin");
  await mkdir(binaryDirectory, { recursive: true });
  const binaries = [];
  for (const name of ["ffmpeg", "ffprobe"]) {
    const source = join(root, "netlify", "functions", "_bin", name);
    const destination = join(binaryDirectory, name);
    await copyFile(source, destination);
    await chmod(destination, 0o755);
    const { stdout } = await execFileAsync(destination, ["-version"]);
    binaries.push({ name, version: String(stdout).split("\n")[0] });
  }

  const sizes = await Promise.all([mcpBundle, cleanupBundle, ...binaries.map(({ name }) => join(binaryDirectory, name))].map(async (file) => (await stat(file)).size));
  const mcpUncompressedBytes = sizes[0] + sizes[2] + sizes[3];
  if (mcpUncompressedBytes > 250 * 1024 * 1024) throw new Error("MCP function exceeds Netlify's 250 MB uncompressed limit");
  console.log(JSON.stringify({
    ok: true,
    mcpUncompressedBytes,
    cleanupBundleBytes: sizes[1],
    binaries,
  }, null, 2));
} finally {
  await rm(output, { recursive: true, force: true });
}
