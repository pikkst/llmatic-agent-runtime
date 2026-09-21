import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assertReleaseVersion,
  parseReleaseManifest,
} from "../packages/release-metadata/dist/index.js";

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
const commit = process.argv[3] || process.env.GITHUB_SHA;
if (!tag || !commit) throw new Error("Release tag and commit SHA are required.");

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionPackage = JSON.parse(
  await readFile(new URL("../apps/vscode-extension/package.json", import.meta.url), "utf8"),
);
const version = assertReleaseVersion(
  tag,
  String(rootPackage.version),
  String(extensionPackage.version),
);

const root = resolve(new URL("..", import.meta.url).pathname);
const sourceVsix = resolve(root, "artifacts", "llmatic-agent-runtime.vsix");
const versionedVsix = resolve(root, "artifacts", "llmatic-agent-runtime-" + version + ".vsix");
const runtimeManifestPath = resolve(
  root,
  "apps",
  "vscode-extension",
  "dist",
  "runtime",
  "manifest.json",
);

const vsixBytes = await readFile(sourceVsix);
await writeFile(versionedVsix, vsixBytes);
const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
const vsixStat = await stat(versionedVsix);

const manifest = parseReleaseManifest({
  schemaVersion: 1,
  version,
  tag,
  commit,
  repository: "pikkst/llmatic-agent-runtime",
  vsix: {
    file: basename(versionedVsix),
    sha256: createHash("sha256").update(vsixBytes).digest("hex"),
    size: vsixStat.size,
  },
  runtime: {
    version: String(runtimeManifest.runtimeVersion),
    sha256: String(runtimeManifest.sha256),
    size: Number(runtimeManifest.size),
  },
});

const output = resolve(root, "artifacts", "release-manifest.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("Release manifest: " + output);
