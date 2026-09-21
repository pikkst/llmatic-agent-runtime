import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface RuntimeManifest {
  schemaVersion: 1;
  runtimeVersion: string;
  file: string;
  sha256: string;
  size: number;
}

export interface RuntimeInstallOptions {
  bundlePath: string;
  manifestPath: string;
  runtimeHome: string;
  force?: boolean;
}

export interface RuntimeInstallResult {
  runtimeVersion: string;
  sha256: string;
  serverPath: string;
  manifestPath: string;
  installDirectory: string;
  changed: boolean;
  healthy: boolean;
  source: "bundled" | "installed" | "override";
}

function assertManifest(value: unknown): RuntimeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime manifest must be a JSON object.");
  }

  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) {
    throw new Error("Unsupported runtime manifest schema version.");
  }
  if (typeof input.runtimeVersion !== "string" || !input.runtimeVersion.trim()) {
    throw new Error("Runtime manifest runtimeVersion is invalid.");
  }
  if (typeof input.file !== "string" || !input.file.trim() || basename(input.file) !== input.file) {
    throw new Error("Runtime manifest file must be a plain file name.");
  }
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw new Error("Runtime manifest sha256 is invalid.");
  }
  if (typeof input.size !== "number" || !Number.isInteger(input.size) || input.size < 0) {
    throw new Error("Runtime manifest size is invalid.");
  }

  return {
    schemaVersion: 1,
    runtimeVersion: input.runtimeVersion,
    file: input.file,
    sha256: input.sha256.toLowerCase(),
    size: input.size,
  };
}

export async function readRuntimeManifest(path: string): Promise<RuntimeManifest> {
  const raw = await readFile(path, "utf8");

  try {
    return assertManifest(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      "Invalid LLMatic runtime manifest: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function fileHealthy(path: string, manifest: RuntimeManifest): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== manifest.size) return false;
    return (await sha256File(path)) === manifest.sha256;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
}

export function runtimeInstallDirectory(runtimeHome: string, manifest: RuntimeManifest): string {
  return resolve(runtimeHome, "runtime", manifest.runtimeVersion, manifest.sha256.slice(0, 16));
}

export async function inspectInstalledRuntime(
  runtimeHome: string,
  manifest: RuntimeManifest,
): Promise<RuntimeInstallResult> {
  const installDirectory = runtimeInstallDirectory(runtimeHome, manifest);
  const serverPath = resolve(installDirectory, manifest.file);
  const manifestPath = resolve(installDirectory, "manifest.json");
  const healthy = await fileHealthy(serverPath, manifest);

  return {
    runtimeVersion: manifest.runtimeVersion,
    sha256: manifest.sha256,
    serverPath,
    manifestPath,
    installDirectory,
    changed: false,
    healthy,
    source: "installed",
  };
}

async function writeAtomic(path: string, content: Buffer | string): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content);

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function installRuntimeBundle(
  options: RuntimeInstallOptions,
): Promise<RuntimeInstallResult> {
  const manifest = await readRuntimeManifest(options.manifestPath);
  const sourceMetadata = await stat(options.bundlePath);

  if (!sourceMetadata.isFile()) {
    throw new Error("Bundled runtime path is not a file.");
  }
  if (sourceMetadata.size !== manifest.size) {
    throw new Error("Bundled runtime size does not match its manifest.");
  }

  const sourceHash = await sha256File(options.bundlePath);
  if (sourceHash !== manifest.sha256) {
    throw new Error("Bundled runtime SHA-256 does not match its manifest.");
  }

  const current = await inspectInstalledRuntime(options.runtimeHome, manifest);
  if (current.healthy && !options.force) {
    return current;
  }

  await mkdir(current.installDirectory, { recursive: true });
  const runtimeContent = await readFile(options.bundlePath);
  await writeAtomic(current.serverPath, runtimeContent);
  await writeAtomic(current.manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const healthy = await fileHealthy(current.serverPath, manifest);
  if (!healthy) {
    throw new Error("Installed LLMatic runtime failed integrity verification.");
  }

  return {
    ...current,
    changed: true,
    healthy: true,
    source: "bundled",
  };
}
