#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  assertReleaseVersion,
  parseReleaseManifest,
} from "../packages/release-metadata/dist/index.js";
import { verifyVsixBytes } from "../packages/update-installer/dist/index.js";

const root = process.cwd();
const tag = process.argv[2] || process.env.GITHUB_REF_NAME || "v0.1.2";
const commit =
  process.argv[3] ||
  process.env.GITHUB_SHA ||
  capture("git", ["rev-parse", "HEAD"]) ||
  "0".repeat(40);

function fail(message) {
  throw new Error("Release acceptance failed: " + message);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error || result.status !== 0) return undefined;
  return String(result.stdout || result.stderr)
    .trim()
    .split(/\r?\n/)[0];
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) fail(label + " could not start: " + result.error.message);
  if (result.status !== 0) fail(label + " exited with " + String(result.status) + ".");
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function size(path) {
  return (await readFile(path)).byteLength;
}

async function extractVsix(vsixPath, destination) {
  await mkdir(destination, { recursive: true });

  if (process.platform === "win32") {
    const escapedVsix = vsixPath.replaceAll("'", "''");
    const escapedDestination = destination.replaceAll("'", "''");
    run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath '" +
          escapedVsix +
          "' -DestinationPath '" +
          escapedDestination +
          "' -Force",
      ],
      "VSIX extraction",
    );
    return;
  }

  run("unzip", ["-q", "-o", vsixPath, "-d", destination], "VSIX extraction");
}

function requireFile(path, label) {
  if (!existsSync(path)) fail(label + " is missing: " + path);
}

const rootPackagePath = resolve(root, "package.json");
const extensionPackagePath = resolve(root, "apps", "vscode-extension", "package.json");
const sourceVsix = resolve(root, "artifacts", "llmatic-agent-runtime.vsix");

requireFile(rootPackagePath, "root package");
requireFile(extensionPackagePath, "extension package");
requireFile(sourceVsix, "candidate VSIX");

const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
const extensionPackage = JSON.parse(await readFile(extensionPackagePath, "utf8"));
const version = assertReleaseVersion(
  tag,
  String(rootPackage.version),
  String(extensionPackage.version),
);

run("node", ["scripts/create-release-manifest.mjs", tag, commit], "release manifest generation");

const versionedVsix = resolve(root, "artifacts", "llmatic-agent-runtime-" + version + ".vsix");
const releaseManifestPath = resolve(root, "artifacts", "release-manifest.json");
requireFile(versionedVsix, "versioned VSIX");
requireFile(releaseManifestPath, "release manifest");

const manifest = parseReleaseManifest(JSON.parse(await readFile(releaseManifestPath, "utf8")));

if (manifest.commit !== commit) fail("manifest commit does not match acceptance commit.");
if (manifest.tag !== tag) fail("manifest tag does not match acceptance tag.");
if (manifest.version !== version) fail("manifest version does not match package versions.");

const vsixBytes = new Uint8Array(await readFile(versionedVsix));
verifyVsixBytes(vsixBytes, manifest.vsix);

const extractionRoot = await mkdtemp(join(tmpdir(), "llmatic-release-"));
const extraction = join(extractionRoot, "vsix-" + randomUUID());

try {
  await extractVsix(versionedVsix, extraction);

  const packagedRoot = resolve(extraction, "extension");
  const packagedPackagePath = resolve(packagedRoot, "package.json");
  const packagedExtensionPath = resolve(packagedRoot, "dist", "extension.cjs");
  const packagedRuntimeManifestPath = resolve(packagedRoot, "dist", "runtime", "manifest.json");
  const packagedRuntimePath = resolve(packagedRoot, "dist", "runtime", "mcp-server.mjs");
  const packagedMarketplaceIconPath = resolve(packagedRoot, "media", "llmatic.png");

  requireFile(packagedPackagePath, "packaged extension package");
  requireFile(packagedExtensionPath, "packaged extension activation bundle");
  requireFile(packagedRuntimeManifestPath, "packaged runtime manifest");
  requireFile(packagedRuntimePath, "packaged MCP runtime");
  requireFile(packagedMarketplaceIconPath, "packaged Marketplace icon");

  const packagedPackage = JSON.parse(await readFile(packagedPackagePath, "utf8"));
  if (String(packagedPackage.version) !== version) {
    fail(
      "packaged extension version " +
        String(packagedPackage.version) +
        " does not match " +
        version +
        ".",
    );
  }
  if (String(packagedPackage.publisher) !== "eventnexus") {
    fail("packaged extension publisher is not eventnexus.");
  }
  if (String(packagedPackage.icon) !== "media/llmatic.png") {
    fail("packaged extension Marketplace icon path is not media/llmatic.png.");
  }
  if (String(packagedPackage.pricing) !== "Free") {
    fail("packaged extension Marketplace pricing is not Free.");
  }
  if (String(packagedPackage.main) !== "./dist/extension.cjs") {
    fail("packaged extension main entry is not ./dist/extension.cjs.");
  }

  const activationBundle = await readFile(packagedExtensionPath, "utf8");
  const requiredActivationSignals = [
    "LLMatic",
    "llmatic.getReady",
    "llmatic.reviewFixLoop",
    "llmatic.checkForUpdates",
    "llmatic.installUpdate",
    "llmatic.repairRuntime",
  ];

  if (activationBundle.length < 10000) {
    fail("packaged extension activation bundle is unexpectedly small.");
  }

  for (const signal of requiredActivationSignals) {
    if (!activationBundle.includes(signal)) {
      fail("packaged extension bundle is missing critical signal " + signal + ".");
    }
  }

  const forbiddenActivationBundleSignals = [
    {
      signal: 'require("./impl/format")',
      detail: "jsonc-parser UMD relative runtime require",
    },
    {
      signal: "jsonc-parser/lib/umd/main.js",
      detail: "jsonc-parser UMD entry",
    },
  ];

  for (const forbidden of forbiddenActivationBundleSignals) {
    if (activationBundle.includes(forbidden.signal)) {
      fail("packaged extension bundle contains unresolved " + forbidden.detail + ".");
    }
  }

  const packagedRuntimeManifest = JSON.parse(await readFile(packagedRuntimeManifestPath, "utf8"));

  if (String(packagedRuntimeManifest.runtimeVersion) !== manifest.runtime.version) {
    fail("packaged runtime version does not match release manifest.");
  }
  if (String(packagedRuntimeManifest.sha256).toLowerCase() !== manifest.runtime.sha256) {
    fail("packaged runtime manifest SHA-256 does not match release manifest.");
  }
  if (Number(packagedRuntimeManifest.size) !== manifest.runtime.size) {
    fail("packaged runtime size does not match release manifest.");
  }

  if ((await sha256(packagedRuntimePath)) !== manifest.runtime.sha256) {
    fail("packaged runtime bytes do not match release runtime SHA-256.");
  }
  if ((await size(packagedRuntimePath)) !== manifest.runtime.size) {
    fail("packaged runtime byte size does not match release runtime size.");
  }

  const forbiddenPaths = [resolve(packagedRoot, ".llmatic"), resolve(packagedRoot, "node_modules")];
  for (const forbidden of forbiddenPaths) {
    if (existsSync(forbidden)) {
      fail("VSIX contains forbidden repository/runtime footprint path: " + forbidden);
    }
  }

  console.log("");
  console.log("========================================");
  console.log("RELEASE ACCEPTANCE PASSED");
  console.log("Tag: " + tag);
  console.log("Commit: " + commit);
  console.log("Version: " + version);
  console.log("VSIX: " + manifest.vsix.file);
  console.log("VSIX SHA-256: " + manifest.vsix.sha256);
  console.log("Runtime SHA-256: " + manifest.runtime.sha256);
  console.log("Activation bundle: verified");
  console.log("Zero-repo package footprint: verified");
  console.log("========================================");
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}
