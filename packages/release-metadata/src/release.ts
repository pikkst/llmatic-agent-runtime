export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  tag: string;
  commit: string;
  repository: string;
  vsix: {
    file: string;
    sha256: string;
    size: number;
  };
  runtime: {
    version: string;
    sha256: string;
    size: number;
  };
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;

function parseSemver(version: string): [number, number, number, string | undefined] {
  const match = SEMVER.exec(version);
  if (!match) throw new Error("Invalid semantic version: " + version);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);

  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return Number(left[index]) > Number(right[index]) ? 1 : -1;
  }

  if (left[3] === right[3]) return 0;
  if (left[3] === undefined) return 1;
  if (right[3] === undefined) return -1;
  return String(left[3]).localeCompare(String(right[3]));
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(name + " must be an object.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(name + " must be a string.");
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(name + " must be a non-negative integer.");
  }
  return value;
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const root = object(value, "release manifest");
  if (root.schemaVersion !== 1) throw new Error("Unsupported release manifest schema.");

  const version = string(root.version, "version");
  parseSemver(version);
  const tag = string(root.tag, "tag");
  if (tag !== "v" + version) throw new Error("Release tag must equal v" + version + ".");

  const commit = string(root.commit, "commit");
  if (!COMMIT.test(commit)) throw new Error("Release commit must be a 40-character Git SHA.");

  const repository = string(root.repository, "repository");
  const vsix = object(root.vsix, "vsix");
  const runtime = object(root.runtime, "runtime");
  const vsixSha = string(vsix.sha256, "vsix.sha256");
  const runtimeSha = string(runtime.sha256, "runtime.sha256");

  if (!SHA256.test(vsixSha) || !SHA256.test(runtimeSha)) {
    throw new Error("Release SHA-256 fields must contain 64 hex characters.");
  }

  return {
    schemaVersion: 1,
    version,
    tag,
    commit,
    repository,
    vsix: {
      file: string(vsix.file, "vsix.file"),
      sha256: vsixSha.toLowerCase(),
      size: integer(vsix.size, "vsix.size"),
    },
    runtime: {
      version: string(runtime.version, "runtime.version"),
      sha256: runtimeSha.toLowerCase(),
      size: integer(runtime.size, "runtime.size"),
    },
  };
}

export function assertReleaseVersion(tag: string, rootVersion: string, extensionVersion: string): string {
  const normalizedTag = tag.trim();
  if (!normalizedTag.startsWith("v")) {
    throw new Error("Release tag must use vX.Y.Z format.");
  }

  const version = normalizedTag.slice(1);
  parseSemver(version);

  if (rootVersion !== version) {
    throw new Error("Root package version " + rootVersion + " does not match tag " + normalizedTag + ".");
  }
  if (extensionVersion !== version) {
    throw new Error(
      "Extension version " + extensionVersion + " does not match tag " + normalizedTag + ".",
    );
  }

  return version;
}
