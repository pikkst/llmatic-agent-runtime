import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { detectCapabilities } from "./capabilities.js";
import type { PackageManager, RepositoryDetection } from "./types.js";

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  const path = join(root, "package.json");

  if (!(await exists(path))) {
    return undefined;
  }

  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PackageJson;
}

function packageManagerFromField(value: string | undefined): PackageManager | undefined {
  if (!value) {
    return undefined;
  }

  const name = value.split("@")[0];

  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    return name;
  }

  return undefined;
}

async function detectPackageManager(
  root: string,
  packageJson: PackageJson | undefined,
): Promise<PackageManager> {
  const declared = packageManagerFromField(packageJson?.packageManager);

  if (declared) {
    return declared;
  }

  const lockFiles: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];

  for (const [filename, manager] of lockFiles) {
    if (await exists(join(root, filename))) {
      return manager;
    }
  }

  return packageJson ? "npm" : "unknown";
}

function detectTechnologies(packageJson: PackageJson | undefined): string[] {
  if (!packageJson) {
    return [];
  }

  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  const known: Array<[string, string]> = [
    ["typescript", "TypeScript"],
    ["react", "React"],
    ["next", "Next.js"],
    ["vite", "Vite"],
    ["vitest", "Vitest"],
    ["jest", "Jest"],
    ["eslint", "ESLint"],
    ["prettier", "Prettier"],
    ["@supabase/supabase-js", "Supabase"],
  ];

  return known
    .filter(([dependency]) => typeof dependencies[dependency] === "string")
    .map(([, technology]) => technology);
}

export async function detectRepository(inputRoot: string): Promise<RepositoryDetection> {
  const root = resolve(inputRoot);
  const packageJson = await readPackageJson(root);
  const packageManager = await detectPackageManager(root, packageJson);

  return {
    root,
    git: await exists(join(root, ".git")),
    packageJson: Boolean(packageJson),
    packageManager,
    technologies: detectTechnologies(packageJson),
    capabilities: detectCapabilities(packageJson?.scripts ?? {}, packageManager),
  };
}
