#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const vsixPath = resolve(repositoryRoot, "artifacts", "llmatic-agent-runtime.vsix");
const extensionPackagePath = resolve(repositoryRoot, "apps", "vscode-extension", "package.json");
const extensionSourcePath = resolve(repositoryRoot, "apps", "vscode-extension");

const CLI_TIMEOUT_MS = 120_000;

function phase(message) {
  console.log("[vscode-acceptance] " + message);
}

function fail(message) {
  throw new Error("VS Code clean-install acceptance failed: " + message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: CLI_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    fail(command + " could not start: " + result.error.message);
  }

  if (result.status !== 0) {
    fail(
      command +
        " exited with " +
        String(result.status) +
        ": " +
        String(result.stderr || result.stdout).trim(),
    );
  }

  return String(result.stdout || "").trim();
}

if (!existsSync(vsixPath)) {
  fail("Candidate VSIX is missing. Run pnpm package:vsix or pnpm ci first.");
}

const extensionPackage = JSON.parse(await readFile(extensionPackagePath, "utf8"));
const expectedVersion = String(extensionPackage.version);
const extensionId = String(extensionPackage.publisher) + "." + String(extensionPackage.name);

const root = await mkdtemp(join(tmpdir(), "llmatic-vscode-acceptance-"));
const workspace = resolve(root, "workspace");
const harness = resolve(root, "harness");
const userData = resolve(root, "user-data");
const extensions = resolve(root, "extensions");

try {
  await mkdir(resolve(workspace, ".git"), {
    recursive: true,
  });
  await mkdir(harness, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(extensions, { recursive: true });

  await writeFile(
    resolve(workspace, "README.md"),
    "# LLMatic VS Code clean-install acceptance\n",
    "utf8",
  );

  await writeFile(
    resolve(harness, "package.json"),
    JSON.stringify(
      {
        name: "llmatic-acceptance-harness",
        displayName: "LLMatic Acceptance Harness",
        publisher: "eventnexus-test",
        version: "0.0.0",
        engines: {
          vscode: "^1.105.0",
        },
        activationEvents: ["*"],
        main: "./extension.cjs",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await writeFile(
    resolve(harness, "extension.cjs"),
    [
      '"use strict";',
      "exports.activate = function activate() {};",
      "exports.deactivate = function deactivate() {};",
      "",
    ].join("\n"),
    "utf8",
  );

  const runnerPath = resolve(harness, "runner.cjs");
  await writeFile(
    runnerPath,
    [
      '"use strict";',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const assert = require("node:assert/strict");',
      'const vscode = require("vscode");',
      "",
      "exports.run = async function run() {",
      "  const extensionId = process.env.LLMATIC_EXTENSION_ID;",
      "  const expectedVersion = process.env.LLMATIC_EXPECTED_VERSION;",
      "  const sourceExtensionPath = process.env.LLMATIC_SOURCE_EXTENSION_PATH;",
      "  const expectedExtensionsDir = process.env.LLMATIC_EXTENSIONS_DIR;",
      '  assert.ok(extensionId, "missing expected extension id");',
      '  assert.ok(expectedVersion, "missing expected extension version");',
      '  assert.ok(expectedExtensionsDir, "missing isolated extensions directory");',
      "",
      "  const target = vscode.extensions.getExtension(extensionId);",
      '  assert.ok(target, "installed LLMatic extension was not discovered");',
      "  assert.equal(target.packageJSON.version, expectedVersion);",
      "  const normalizePath = (value) => {",
      "    const normalized = path.resolve(value);",
      '    return process.platform === "win32" ? normalized.toLowerCase() : normalized;',
      "  };",
      "  assert.ok(",
      "    normalizePath(target.extensionPath).startsWith(",
      "      normalizePath(expectedExtensionsDir) + path.sep,",
      "    ),",
      '    "installed extension was not loaded from the isolated VSIX extensions directory",',
      "  );",
      "  if (sourceExtensionPath) {",
      "    assert.notEqual(",
      "      path.resolve(target.extensionPath),",
      "      path.resolve(sourceExtensionPath),",
      '      "acceptance loaded the source extension instead of the installed VSIX",',
      "    );",
      "  }",
      "",
      "  await target.activate();",
      '  assert.equal(target.isActive, true, "installed extension did not activate");',
      "",
      "  const commands = new Set(await vscode.commands.getCommands(true));",
      "  const requiredCommands = [",
      '    "llmatic.startDiscovery",',
      '    "llmatic.generatePlan",',
      '    "llmatic.planReview",',
      '    "llmatic.approveAndInitialize",',
      '    "llmatic.getReady",',
      '    "llmatic.repairRuntime",',
      '    "llmatic.reviewFixLoop",',
      '    "llmatic.openAgentChat",',
      '    "llmatic.agentChatProbe",',
      '    "llmatic.reviewExternalPullRequest",',
      '    "llmatic.configureAutoReview",',
      '    "llmatic.checkForUpdates",',
      '    "llmatic.installUpdate",',
      "  ];",
      "  for (const command of requiredCommands) {",
      '    assert.ok(commands.has(command), "missing installed command " + command);',
      "  }",
      "",
      '  await vscode.commands.executeCommand("llmatic.openAgentChat");',
      '  const agentChatReady = await vscode.commands.executeCommand("llmatic.agentChatProbe");',
      "  assert.equal(",
      "    agentChatReady,",
      "    true,",
      '    "installed Agent Chat webview client did not execute its ready handshake",',
      "  );",
      "",
      "  const folder = vscode.workspace.workspaceFolders?.[0];",
      '  assert.ok(folder, "acceptance workspace did not open");',
      "  const workspaceRoot = folder.uri.fsPath;",
      "  assert.equal(",
      '    fs.existsSync(path.join(workspaceRoot, ".llmatic")),',
      "    false,",
      '    "installed extension created .llmatic inside the repository",',
      "  );",
      "  assert.equal(",
      '    fs.existsSync(path.join(workspaceRoot, "llmatic.agent.yaml")),',
      "    false,",
      '    "installed extension created llmatic.agent.yaml inside the repository",',
      "  );",
      "",
      '  console.log("LLMATIC_EXTENSION_HOST_ACCEPTANCE_PASSED");',
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousCwd = process.cwd();
  process.chdir(root);

  try {
    const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } =
      await import("@vscode/test-electron");

    phase("Downloading/unpacking VS Code 1.105.0.");
    const vscodeExecutablePath = await downloadAndUnzipVSCode("1.105.0");
    phase("VS Code 1.105.0 is ready.");

    const [cliPath, ...cliBaseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
      reuseMachineInstall: true,
    });

    const profileArgs = ["--user-data-dir", userData, "--extensions-dir", extensions];

    phase("Installing candidate VSIX into the isolated extensions directory.");
    run(
      cliPath,
      [...cliBaseArgs, ...profileArgs, "--install-extension", vsixPath, "--force"],
      root,
    );
    phase("Candidate VSIX installation completed.");

    // Do not use a second VS Code CLI process to enumerate installed extensions here.
    // On Linux CI it can remain attached to the install process/profile and time out.
    // The Extension Host harness below performs the stronger identity, version and
    // isolated-install-path assertions before activating the extension.
    phase("Launching the isolated Extension Host and verifying the installed extension.");

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: harness,
      extensionTestsPath: runnerPath,
      reuseMachineInstall: true,
      launchArgs: [workspace, ...profileArgs, "--disable-workspace-trust"],
      extensionTestsEnv: {
        LLMATIC_EXTENSION_ID: extensionId,
        LLMATIC_EXPECTED_VERSION: expectedVersion,
        LLMATIC_SOURCE_EXTENSION_PATH: extensionSourcePath,
        LLMATIC_EXTENSIONS_DIR: extensions,
      },
    });
    phase("Extension Host acceptance completed.");
  } finally {
    process.chdir(previousCwd);
  }

  console.log("");
  console.log("========================================");
  console.log("VS CODE CLEAN-INSTALL ACCEPTANCE PASSED");
  console.log("VS Code: 1.105.0");
  console.log("Extension: " + extensionId + "@" + expectedVersion);
  console.log("Install source: isolated VSIX extensions directory");
  console.log("Activation: verified");
  console.log("Critical commands: verified");
  console.log("Agent Chat webview bootstrap: verified");
  console.log("Zero-repo footprint: verified");
  console.log("========================================");
} finally {
  await rm(root, {
    recursive: true,
    force: true,
  });
}
