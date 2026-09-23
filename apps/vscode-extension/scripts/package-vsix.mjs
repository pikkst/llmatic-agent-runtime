import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const extensionRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(extensionRoot, "..", "..");
const artifactsRoot = resolve(repositoryRoot, "artifacts");
const packageJson = JSON.parse(await readFile(resolve(extensionRoot, "package.json"), "utf8"));
const version = String(packageJson.version);
const output = resolve(artifactsRoot, "llmatic-agent-runtime.vsix");
const versionedOutput = resolve(artifactsRoot, "llmatic-agent-runtime-" + version + ".vsix");

await mkdir(dirname(output), { recursive: true });

function runPnpm(args, label) {
  const result = spawnSync("pnpm", args, {
    cwd: extensionRoot,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw new Error(label + " could not start: " + result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(label + " failed with exit code " + String(result.status) + ".");
  }
}

// Packaging must be self-contained. Rebuild the extension and bundled MCP runtime
// immediately before creating the VSIX so source changes can never be packaged
// with a stale dist/extension.cjs from an earlier build.
runPnpm(["run", "bundle"], "VSIX bundle rebuild");

// Never leave an older candidate under either canonical install name.
await Promise.all([rm(output, { force: true }), rm(versionedOutput, { force: true })]);

runPnpm(
  ["exec", "vsce", "package", "--no-dependencies", "--out", output],
  "VSIX packaging",
);

const bytes = await readFile(output);
await copyFile(output, versionedOutput);

const sha256 = createHash("sha256").update(bytes).digest("hex");
const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  env: process.env,
  encoding: "utf8",
  shell: false,
});
const commit =
  !commitResult.error && commitResult.status === 0 ? String(commitResult.stdout).trim() : "unknown";

console.log("");
console.log("========================================");
console.log("VSIX CANDIDATE PACKAGED");
console.log("Commit: " + commit);
console.log("Version: " + version);
console.log("VSIX: " + output);
console.log("Versioned VSIX: " + versionedOutput);
console.log("VSIX SHA-256: " + sha256);
console.log("========================================");
