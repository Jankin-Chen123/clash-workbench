import { mkdir, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";

const version = "v1.19.17";
const substoreVersion = "2.44.30";
const parserHash =
  "ecc2db53786eb9ac0bd70a221513a588b6c54f32139f8fa3c175cd2ede00ab45";
const platform = { win32: "windows", linux: "linux", darwin: "darwin" }[
  process.platform
];
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!platform || !arch)
  throw new Error("This platform needs a manually installed Mihomo binary");
await mkdir(resolve("bin"), { recursive: true });

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok)
    throw new Error(`Download failed (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

const asset = `mihomo-${platform}-${arch}${arch === "amd64" ? "-compatible" : ""}-${version}${platform === "windows" ? ".zip" : ".gz"}`;
console.log(`Installing Mihomo ${version} and Sub-Store ${substoreVersion}…`);
const archive = await download(
  `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${asset}`,
);
let binary;
if (platform === "windows") {
  // Use the platform ZIP utility without invoking shell-built command strings.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(resolve(tmpdir(), "clash-core-"));
  try {
    await writeFile(resolve(dir, "core.zip"), archive);
    await promisify(execFile)("tar", [
      "-xf",
      resolve(dir, "core.zip"),
      "-C",
      dir,
    ]);
    const file = (await readdir(dir)).find((name) => name.endsWith(".exe"));
    if (!file) throw new Error("Mihomo executable missing in archive");
    binary = await readFile(resolve(dir, file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else binary = gunzipSync(archive);
const target = resolve("bin", platform === "windows" ? "mihomo.exe" : "mihomo");
await writeFile(target, binary);
await chmod(target, 0o755);
const parser = await download(
  `https://github.com/sub-store-org/Sub-Store/releases/download/${substoreVersion}/proxy-utils.esm.mjs`,
);
if (createHash("sha256").update(parser).digest("hex") !== parserHash)
  throw new Error("Sub-Store checksum mismatch");
await writeFile(resolve("bin/substore.mjs"), parser);
await writeFile(
  resolve("bin/LICENSE.mihomo"),
  await download(
    `https://raw.githubusercontent.com/MetaCubeX/mihomo/${version}/LICENSE`,
  ),
);
await writeFile(
  resolve("bin/LICENSE.substore"),
  await download(
    `https://raw.githubusercontent.com/sub-store-org/Sub-Store/${substoreVersion}/LICENSE`,
  ),
);
console.log("Dependencies ready. Run npm run dev to open the workbench.");
