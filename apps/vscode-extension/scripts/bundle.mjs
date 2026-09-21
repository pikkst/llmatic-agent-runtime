import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const extensionRoot = resolve(import.meta.dirname, "..");
const dist = resolve(extensionRoot, "dist");

await mkdir(resolve(dist, "runtime"), { recursive: true });

await build({
  entryPoints: [resolve(extensionRoot, "src", "extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
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
  outfile: resolve(dist, "runtime", "mcp-server.mjs"),
  sourcemap: true,
  logLevel: "info",
});
