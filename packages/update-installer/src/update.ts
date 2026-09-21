import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface ExpectedVsix {
  file: string;
  sha256: string;
  size: number;
}

export interface StageVerifiedVsixOptions {
  bytes: Uint8Array;
  expected: ExpectedVsix;
  updateHome: string;
  version: string;
}

export interface StagedVsix {
  path: string;
  sha256: string;
  size: number;
  changed: boolean;
}

function assertPlainVsixName(file: string): void {
  if (!file || basename(file) !== file || !file.endsWith(".vsix")) {
    throw new Error("Update VSIX file must be a plain .vsix file name.");
  }
}

export function verifyVsixBytes(bytes: Uint8Array, expected: ExpectedVsix): string {
  assertPlainVsixName(expected.file);

  if (bytes.byteLength !== expected.size) {
    throw new Error(
      "Downloaded VSIX size " +
        bytes.byteLength +
        " does not match manifest size " +
        expected.size +
        ".",
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expected.sha256.toLowerCase()) {
    throw new Error("Downloaded VSIX SHA-256 does not match the release manifest.");
  }

  return sha256;
}

export async function stageVerifiedVsix(
  options: StageVerifiedVsixOptions,
): Promise<StagedVsix> {
  const sha256 = verifyVsixBytes(options.bytes, options.expected);
  const directory = resolve(
    options.updateHome,
    "updates",
    options.version,
    sha256.slice(0, 16),
  );
  const path = resolve(directory, options.expected.file);
  const temporary = path + "." + randomUUID() + ".tmp";

  await mkdir(directory, { recursive: true });
  await writeFile(temporary, options.bytes);

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return {
    path,
    sha256,
    size: options.bytes.byteLength,
    changed: true,
  };
}
