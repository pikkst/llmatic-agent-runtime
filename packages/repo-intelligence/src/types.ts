export type RepositoryLanguage =
  | "typescript"
  | "javascript"
  | "json"
  | "markdown"
  | "yaml"
  | "sql"
  | "python"
  | "other";

export type RepositorySymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "method";

export interface RepositoryFileEntry {
  path: string;
  extension: string;
  language: RepositoryLanguage;
  size: number;
  sourceIndexed: boolean;
}

export interface RepositorySymbol {
  name: string;
  kind: RepositorySymbolKind;
  path: string;
  line: number;
  exported: boolean;
  container?: string;
}

export interface RepositoryImport {
  path: string;
  specifier: string;
  names: string[];
  typeOnly: boolean;
}

export interface RepositoryIndex {
  version: 1;
  root: string;
  generatedAt: string;
  fileCount: number;
  sourceFileCount: number;
  files: RepositoryFileEntry[];
  symbols: RepositorySymbol[];
  imports: RepositoryImport[];
}

export interface RepositorySearchHit {
  kind: "symbol" | "file" | "import";
  path: string;
  label: string;
  line?: number;
  score: number;
}
