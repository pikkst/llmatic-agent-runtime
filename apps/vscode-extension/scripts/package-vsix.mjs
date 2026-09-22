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

// Never leave an older candidate under either canonical install name.
await Promise.all([rm(output, { force: true }), rm(versionedOutput, { force: true })]);

const result = spawnSync(
  "pnpm",
  ["exec", "vsce", "package", "--no-dependencies", "--out", output],
  {
    cwd: extensionRoot,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

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
