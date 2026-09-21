#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const isCi = process.argv.includes("--ci");

function printHeader(title) {
  console.log("");
  console.log("=== " + title + " ===");
}

function fail(message) {
  console.error("");
  console.error("FAIL: " + message);
  process.exit(1);
}

function run(command, args, label) {
  printHeader(label);

  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (result.error) {
    fail(label + " could not start: " + result.error.message);
  }

  if (result.status !== 0) {
    fail(label + " failed with exit code " + String(result.status) + " after " + seconds + "s.");
  }

  console.log("PASS: " + label + " (" + seconds + "s)");
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    return undefined;
  }

  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
}

function assertEnvironment() {
  printHeader("Environment verification");

  const nodeVersion = process.version;
  const nodeMajor = Number(nodeVersion.replace(/^v/, "").split(".")[0]);

  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    fail("Node.js 20+ is required. Detected " + nodeVersion + ".");
  }

  console.log("PASS: Node.js " + nodeVersion);

  const gitVersion = capture("git", ["--version"]);
  if (!gitVersion) {
    fail("Git is required and must be available on PATH.");
  }
  console.log("PASS: " + gitVersion);

  const pnpmVersion = capture("pnpm", ["--version"]);
  if (!pnpmVersion) {
    fail(
      "pnpm is required. Run through Corepack (for example: corepack pnpm install) or enable Corepack.",
    );
  }
  console.log("PASS: pnpm " + pnpmVersion);

  if (!existsSync("package.json")) {
    fail("package.json was not found in the current working directory.");
  }

  if (!existsSync("node_modules")) {
    fail("node_modules is missing. Run pnpm install before the local CI pipeline.");
  }

  console.log("PASS: dependencies are installed");
}

console.log("LLMatic Agent Runtime - " + (isCi ? "CI" : "Local CI"));
console.log("Repository: " + root);

const pipelineStartedAt = Date.now();

assertEnvironment();

// Keep local and hosted CI on the same deterministic quality-gate sequence.
run("pnpm", ["format:check"], "Formatting verification");
run("pnpm", ["typecheck"], "TypeScript typecheck");
run("pnpm", ["test"], "Test suite");
run("pnpm", ["build"], "Production build");

// Smoke-test the compiled CLI so a green TypeScript build is not enough by itself.
run(
  "node",
  ["apps/cli/dist/index.js", "detect", "--root", root, "--json"],
  "CLI detect smoke test",
);
run("node", ["apps/cli/dist/index.js", "doctor", "--root", root], "CLI doctor smoke test");

const totalSeconds = ((Date.now() - pipelineStartedAt) / 1000).toFixed(1);

console.log("");
console.log("========================================");
console.log("LOCAL CI PASSED");
console.log("Total duration: " + totalSeconds + "s");
console.log("========================================");
