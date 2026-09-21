import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import ts from "typescript";
import type { AgentConfig, WorkflowRun, WorkflowStateStore } from "@llmatic/core";
import { recordActionCheckpoint, transitionWorkflow } from "@llmatic/core";
import type {
  RepositoryFileEntry,
  RepositoryImport,
  RepositoryIndex,
  RepositoryLanguage,
  RepositorySearchHit,
  RepositorySymbol,
  RepositorySymbolKind,
} from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".llmatic",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface RepositoryIndexOptions {
  approved?: boolean;
}

function assertReadPermission(config: AgentConfig, approved: boolean): void {
  const permission = config.permissions.repositoryRead;

  if (permission === "deny") {
    throw new Error("Repository read is denied by llmatic.agent.yaml.");
  }

  if (permission === "ask" && !approved) {
    throw new Error(
      "Repository read requires approval. Re-run with --approve after reviewing the operation.",
    );
  }
}

function portablePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replaceAll("\\", "/");
}

function languageFor(extension: string): RepositoryLanguage {
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  if (extension === ".json") return "json";
  if ([".md", ".mdx"].includes(extension)) return "markdown";
  if ([".yml", ".yaml"].includes(extension)) return "yaml";
  if (extension === ".sql") return "sql";
  if (extension === ".py") return "python";
  return "other";
}

function scriptKindFor(extension: string): ts.ScriptKind {
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isExported(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function lineFor(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function pushNamedSymbol(
  symbols: RepositorySymbol[],
  sourceFile: ts.SourceFile,
  path: string,
  node: ts.Node,
  name: string | undefined,
  kind: RepositorySymbolKind,
  exported: boolean,
  container?: string,
): void {
  if (!name) return;

  symbols.push({
    name,
    kind,
    path,
    line: lineFor(sourceFile, node),
    exported,
    container,
  });
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];

  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function importNames(statement: ts.ImportDeclaration): string[] {
  const clause = statement.importClause;
  if (!clause) return [];

  const names: string[] = [];

  if (clause.name) names.push(clause.name.text);

  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      names.push(clause.namedBindings.name.text);
    } else {
      names.push(...clause.namedBindings.elements.map((element) => element.name.text));
    }
  }

  return names;
}

function collectSourceIntelligence(
  relativePath: string,
  content: string,
  extension: string,
): { symbols: RepositorySymbol[]; imports: RepositoryImport[] } {
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(extension),
  );

  const symbols: RepositorySymbol[] = [];
  const imports: RepositoryImport[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push({
        path: relativePath,
        specifier: statement.moduleSpecifier.text,
        names: importNames(statement),
        typeOnly: Boolean(statement.importClause?.isTypeOnly),
      });
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        imports.push({
          path: relativePath,
          specifier: statement.moduleSpecifier.text,
          names:
            statement.exportClause && ts.isNamedExports(statement.exportClause)
              ? statement.exportClause.elements.map((element) => element.name.text)
              : [],
          typeOnly: statement.isTypeOnly,
        });
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      pushNamedSymbol(
        symbols,
        sourceFile,
        relativePath,
        statement,
        statement.name?.text,
        "function",
        isExported(statement),
      );
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const className = statement.name?.text;
      pushNamedSymbol(
        symbols,
        sourceFile,
        relativePath,
        statement,
        className,
        "class",
        isExported(statement),
      );

      for (const member of statement.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        ) {
          pushNamedSymbol(
            symbols,
            sourceFile,
            relativePath,
            member,
            member.name.text,
            "method",
            isExported(statement),
            className,
          );
        }
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      pushNamedSymbol(
        symbols,
        sourceFile,
        relativePath,
        statement,
        statement.name.text,
        "interface",
        isExported(statement),
      );
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      pushNamedSymbol(
        symbols,
        sourceFile,
        relativePath,
        statement,
        statement.name.text,
        "type",
        isExported(statement),
      );
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      pushNamedSymbol(
        symbols,
        sourceFile,
        relativePath,
        statement,
        statement.name.text,
        "enum",
        isExported(statement),
      );
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          pushNamedSymbol(
            symbols,
            sourceFile,
            relativePath,
            declaration,
            name,
            "variable",
            isExported(statement),
          );
        }
      }
    }
  }

  return { symbols, imports };
}

async function scanDirectory(
  root: string,
  directory: string,
  files: RepositoryFileEntry[],
  symbols: RepositorySymbol[],
  imports: RepositoryImport[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;

    const absolutePath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await scanDirectory(root, absolutePath, files, symbols, imports);
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const fileStat = await stat(absolutePath);
    const extension = extname(entry.name).toLowerCase();
    const relativePath = portablePath(root, absolutePath);
    const sourceIndexed = SOURCE_EXTENSIONS.has(extension) && fileStat.size <= MAX_SOURCE_BYTES;

    files.push({
      path: relativePath,
      extension,
      language: languageFor(extension),
      size: fileStat.size,
      sourceIndexed,
    });

    if (!sourceIndexed) continue;

    const content = await readFile(absolutePath, "utf8");
    const intelligence = collectSourceIntelligence(relativePath, content, extension);
    symbols.push(...intelligence.symbols);
    imports.push(...intelligence.imports);
  }
}

function cachePath(root: string, config: AgentConfig): string {
  return resolve(root, config.runtime.cacheDirectory, "repo-index.json");
}

async function writeIndex(path: string, index: RepositoryIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = path + "." + randomUUID() + ".tmp";

  await writeFile(temporaryPath, JSON.stringify(index, null, 2) + "\n", "utf8");

  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function buildRepositoryIndex(
  root: string,
  config: AgentConfig,
  options: RepositoryIndexOptions = {},
): Promise<RepositoryIndex> {
  assertReadPermission(config, options.approved ?? false);

  const resolvedRoot = resolve(root);
  const files: RepositoryFileEntry[] = [];
  const symbols: RepositorySymbol[] = [];
  const imports: RepositoryImport[] = [];

  await scanDirectory(resolvedRoot, resolvedRoot, files, symbols, imports);

  const index: RepositoryIndex = {
    version: 1,
    root: resolvedRoot,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    sourceFileCount: files.filter((file) => file.sourceIndexed).length,
    files,
    symbols,
    imports,
  };

  await writeIndex(cachePath(resolvedRoot, config), index);
  return index;
}

export async function loadRepositoryIndex(
  root: string,
  config: AgentConfig,
): Promise<RepositoryIndex> {
  const path = cachePath(resolve(root), config);

  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as RepositoryIndex;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;

    if (code === "ENOENT") {
      throw new Error("Repository index was not found. Run llmatic repo index first.");
    }

    throw error;
  }
}

function textScore(value: string, query: string): number {
  const normalized = value.toLowerCase();
  if (normalized === query) return 100;
  if (normalized.startsWith(query)) return 75;
  if (normalized.includes(query)) return 50;
  return 0;
}

export function searchRepositoryIndex(
  index: RepositoryIndex,
  queryInput: string,
  limit = 20,
): RepositorySearchHit[] {
  const query = queryInput.trim().toLowerCase();
  if (!query) throw new Error("Repository search query must not be empty.");

  const hits: RepositorySearchHit[] = [];

  for (const symbol of index.symbols) {
    const score = Math.max(textScore(symbol.name, query), textScore(symbol.path, query));
    if (!score) continue;

    hits.push({
      kind: "symbol",
      path: symbol.path,
      label: symbol.kind + " " + (symbol.container ? symbol.container + "." : "") + symbol.name,
      line: symbol.line,
      score: score + 20,
    });
  }

  for (const file of index.files) {
    const score = textScore(file.path, query);
    if (!score) continue;

    hits.push({
      kind: "file",
      path: file.path,
      label: file.language + " file",
      score,
    });
  }

  for (const edge of index.imports) {
    const score = Math.max(
      textScore(edge.specifier, query),
      ...edge.names.map((name) => textScore(name, query)),
    );
    if (!score) continue;

    hits.push({
      kind: "import",
      path: edge.path,
      label: "imports " + edge.specifier,
      score: score + 10,
    });
  }

  return hits
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path) ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}

export async function analyzeWorkflowRepository(
  root: string,
  config: AgentConfig,
  store: WorkflowStateStore,
  options: RepositoryIndexOptions = {},
): Promise<{ index: RepositoryIndex; workflow: WorkflowRun }> {
  const current = await store.loadCurrent();

  if (!current || current.state !== "TASK_VALIDATED") {
    throw new Error("Workflow repository analysis requires state TASK_VALIDATED.");
  }

  try {
    const index = await buildRepositoryIndex(root, config, options);

    await recordActionCheckpoint(store, {
      provider: "repo-intelligence",
      action: "index.build",
      success: true,
      detail:
        index.fileCount +
        " files, " +
        index.symbols.length +
        " symbols, " +
        index.imports.length +
        " imports",
    });

    const workflow = await transitionWorkflow(store, "REPO_ANALYZED");
    return { index, workflow };
  } catch (error) {
    await recordActionCheckpoint(store, {
      provider: "repo-intelligence",
      action: "index.build",
      success: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
