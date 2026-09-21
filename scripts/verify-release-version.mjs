import { readFile } from "node:fs/promises";
import { assertReleaseVersion } from "../packages/release-metadata/dist/index.js";

const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (!tag) throw new Error("Release tag is required.");

const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extension = JSON.parse(
  await readFile(new URL("../apps/vscode-extension/package.json", import.meta.url), "utf8"),
);

const version = assertReleaseVersion(tag, String(root.version), String(extension.version));
console.log("Release version verified: " + version);
