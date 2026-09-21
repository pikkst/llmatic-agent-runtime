import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const extensionRoot = resolve(import.meta.dirname, "..");
const output = resolve(extensionRoot, "..", "..", "artifacts", "llmatic-agent-runtime.vsix");

await mkdir(dirname(output), { recursive: true });

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

console.log("VSIX: " + output);
