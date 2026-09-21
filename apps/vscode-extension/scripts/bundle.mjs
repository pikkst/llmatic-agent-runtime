import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const extensionRoot = resolve(import.meta.dirname, "..");
const dist = resolve(extensionRoot, "dist");
const runtimeDirectory = resolve(dist, "runtime");
const runtimePath = resolve(runtimeDirectory, "mcp-server.mjs");

await mkdir(runtimeDirectory, { recursive: true });

await build({
  entryPoints: [resolve(extensionRoot, "src", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  mainFields: ["module", "main"],
  outfile: resolve(dist, "extension.cjs"),
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
});

await build({
  entryPoints: [resolve(extensionRoot, "..", "mcp-server", "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: runtimePath,
  sourcemap: true,
  logLevel: "info",
});

const extensionPackage = JSON.parse(await readFile(resolve(extensionRoot, "package.json"), "utf8"));
const runtime = await readFile(runtimePath);
const metadata = await stat(runtimePath);
const manifest = {
  schemaVersion: 1,
  runtimeVersion: String(extensionPackage.version),
  file: "mcp-server.mjs",
  sha256: createHash("sha256").update(runtime).digest("hex"),
  size: metadata.size,
};

await writeFile(
  resolve(runtimeDirectory, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);
