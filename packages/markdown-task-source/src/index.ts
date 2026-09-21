import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { AgentConfig } from "@llmatic/core";
import {
  assertTaskPermission,
  normalizeTaskLifecycleStatus,
  type TaskProvider,
  type TaskProviderOperationOptions,
  type TaskRecord,
  type TaskTransition,
} from "@llmatic/task-provider";

const TASK_FILE_CANDIDATES = [
  "TASKS.md",
  "Tasks.md",
  "tasks.md",
  "TODO.md",
  "Todo.md",
  "todo.md",
] as const;

const TASK_HEADING = /^(#{2,6})\s+([A-Za-z][A-Za-z0-9_.-]*-\d+)\s*(?:[-—:]\s*)?(.*)$/gm;

interface TaskBlock {
  key: string;
  summary: string;
  start: number;
  end: number;
  raw: string;
}

function bullets(text: string | undefined): string[] {
  if (!text?.trim()) return [];

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim(),
    )
    .filter(Boolean);
}

function section(block: string, names: readonly string[]): string | undefined {
  const lines = block.split(/\r?\n/);
  let active = false;
  const collected: string[] = [];

  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);

    if (heading) {
      if (active) break;
      active = names.some((name) => name.toLowerCase() === heading[1]!.trim().toLowerCase());
      continue;
    }

    if (active) collected.push(line);
  }

  const value = collected.join("\n").trim();
  return value || undefined;
}

function statusName(block: string): string {
  return /^Status:\s*(.+)$/im.exec(block)?.[1]?.trim() || "Todo";
}

function parseBlocks(raw: string): TaskBlock[] {
  const matches = [...raw.matchAll(TASK_HEADING)];

  return matches.map((match, index) => ({
    key: match[2]!,
    summary: (match[3]?.trim() || match[2]!).trim(),
    start: match.index!,
    end: matches[index + 1]?.index ?? raw.length,
    raw: raw.slice(match.index!, matches[index + 1]?.index ?? raw.length),
  }));
}

function toTask(filePath: string, block: TaskBlock): TaskRecord {
  const status = statusName(block.raw);
  const dependenciesText = section(block.raw, ["Dependencies", "Depends on", "Dependency"]);
  let dependencies = bullets(dependenciesText).filter((value) => {
    const normalized = value.trim().toLowerCase();
    return !["none", "n/a", "na", "not applicable", "-"].includes(normalized);
  });

  if (dependencies.length === 1 && dependencies[0]!.includes(",")) {
    dependencies = dependencies[0]!
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return {
    provider: "markdown",
    id: block.key,
    key: block.key,
    summary: block.summary,
    description: section(block.raw, ["Description", "Goal", "Objective"]),
    status: {
      id: status.toLowerCase().replace(/\s+/g, "_"),
      name: status,
      lifecycle: normalizeTaskLifecycleStatus(status),
    },
    labels: [],
    acceptanceCriteria: bullets(
      section(block.raw, ["Acceptance criteria", "Acceptance Criteria", "AC"]),
    ),
    definitionOfDone: bullets(
      section(block.raw, ["DoD", "Definition of Done", "Definition Of Done"]),
    ),
    dependencies,
    source: {
      type: "markdown",
      location: filePath,
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectMarkdownTaskFile(root: string): Promise<string | undefined> {
  for (const candidate of TASK_FILE_CANDIDATES) {
    const path = resolve(root, candidate);
    if (await exists(path)) return path;
  }

  return undefined;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, "utf8");

  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function transitionDefinitions(task: TaskRecord): TaskTransition[] {
  switch (task.status.lifecycle) {
    case "todo":
      return [
        { id: "start", name: "Start", toStatus: "In Progress" },
        { id: "block", name: "Block", toStatus: "Blocked" },
        { id: "complete", name: "Complete", toStatus: "Done" },
      ];
    case "in_progress":
      return [
        { id: "block", name: "Block", toStatus: "Blocked" },
        { id: "complete", name: "Complete", toStatus: "Done" },
      ];
    case "blocked":
      return [
        { id: "start", name: "Start", toStatus: "In Progress" },
        { id: "complete", name: "Complete", toStatus: "Done" },
      ];
    case "done":
      return [{ id: "reopen", name: "Reopen", toStatus: "Todo" }];
    default:
      return [
        { id: "start", name: "Start", toStatus: "In Progress" },
        { id: "complete", name: "Complete", toStatus: "Done" },
      ];
  }
}

export class MarkdownTaskProvider implements TaskProvider {
  public readonly id = "markdown";

  public constructor(
    private readonly runtimeConfig: AgentConfig,
    public readonly filePath: string,
  ) {}

  private async raw(): Promise<string> {
    return readFile(this.filePath, "utf8");
  }

  public async listTasks(options: TaskProviderOperationOptions = {}): Promise<TaskRecord[]> {
    assertTaskPermission(this.runtimeConfig, "read", options.approved ?? false);
    const raw = await this.raw();
    return parseBlocks(raw).map((block) => toTask(this.filePath, block));
  }

  public async getTask(
    reference: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskRecord> {
    const tasks = await this.listTasks(options);
    const normalized = reference.trim().toLowerCase();
    const task = tasks.find(
      (item) => item.key.toLowerCase() === normalized || item.id.toLowerCase() === normalized,
    );

    if (!task) {
      throw new Error("Task " + reference + " was not found in " + basename(this.filePath) + ".");
    }

    return task;
  }

  public async getNextTask(
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskRecord | undefined> {
    const tasks = await this.listTasks(options);
    const byKey = new Map(tasks.map((task) => [task.key.toLowerCase(), task]));

    return tasks.find((task) => {
      if (task.status.lifecycle !== "todo") return false;

      return task.dependencies.every((dependency) => {
        const required = byKey.get(dependency.toLowerCase());
        return Boolean(required && required.status.lifecycle === "done");
      });
    });
  }

  public async listTransitions(
    reference: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskTransition[]> {
    return transitionDefinitions(await this.getTask(reference, options));
  }

  public async addComment(
    reference: string,
    text: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<void> {
    assertTaskPermission(this.runtimeConfig, "write", options.approved ?? false);
    const note = text.trim();
    if (!note) throw new Error("Task note must not be empty.");

    const raw = await this.raw();
    const block = parseBlocks(raw).find(
      (item) => item.key.toLowerCase() === reference.trim().toLowerCase(),
    );

    if (!block) {
      throw new Error("Task " + reference + " was not found in " + basename(this.filePath) + ".");
    }

    const notesHeading = /^###\s+Notes\s*$/im;
    let updatedBlock = block.raw;
    const notes = notesHeading.exec(updatedBlock);

    if (notes?.index !== undefined) {
      const afterHeading = notes.index + notes[0].length;
      const rest = updatedBlock.slice(afterHeading);
      const next = /^###\s+/m.exec(rest);
      const insertAt = next?.index !== undefined ? afterHeading + next.index : updatedBlock.length;
      const prefix = updatedBlock.slice(0, insertAt).replace(/\s*$/, "");
      const suffix = updatedBlock.slice(insertAt);
      updatedBlock = prefix + "\n- " + note + "\n" + suffix;
    } else {
      updatedBlock = updatedBlock.replace(/\s*$/, "") + "\n\n### Notes\n- " + note + "\n";
    }

    await writeAtomic(
      this.filePath,
      raw.slice(0, block.start) + updatedBlock + raw.slice(block.end),
    );
  }

  public async transitionTask(
    reference: string,
    transitionInput: string,
    options: TaskProviderOperationOptions = {},
  ): Promise<TaskTransition> {
    assertTaskPermission(this.runtimeConfig, "write", options.approved ?? false);
    const task = await this.getTask(reference, {
      approved: options.approved,
    });
    const available = transitionDefinitions(task);
    const normalized = transitionInput.trim().toLowerCase();
    const transition = available.find(
      (candidate) =>
        candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized,
    );

    if (!transition?.toStatus) {
      throw new Error(
        "Task transition " +
          transitionInput +
          " is not available. Available: " +
          available.map((candidate) => candidate.name).join(", "),
      );
    }

    const raw = await this.raw();
    const block = parseBlocks(raw).find(
      (item) => item.key.toLowerCase() === task.key.toLowerCase(),
    );

    if (!block) {
      throw new Error("Task " + reference + " disappeared from " + basename(this.filePath) + ".");
    }

    const status = /^Status:\s*.*$/im;
    let updatedBlock: string;

    if (status.test(block.raw)) {
      updatedBlock = block.raw.replace(status, "Status: " + transition.toStatus);
    } else {
      const lineEnd = block.raw.indexOf("\n");
      updatedBlock =
        lineEnd >= 0
          ? block.raw.slice(0, lineEnd + 1) +
            "\nStatus: " +
            transition.toStatus +
            "\n" +
            block.raw.slice(lineEnd + 1)
          : block.raw + "\n\nStatus: " + transition.toStatus + "\n";
    }

    await writeAtomic(
      this.filePath,
      raw.slice(0, block.start) + updatedBlock + raw.slice(block.end),
    );

    return transition;
  }
}

export async function createMarkdownTaskProvider(
  root: string,
  runtimeConfig: AgentConfig,
  filePath?: string,
): Promise<MarkdownTaskProvider> {
  const resolved = filePath ? resolve(root, filePath) : await detectMarkdownTaskFile(root);

  if (!resolved) {
    throw new Error(
      "No Markdown task file found. Expected TASKS.md, Tasks.md, tasks.md, TODO.md, Todo.md, or todo.md.",
    );
  }

  return new MarkdownTaskProvider(runtimeConfig, resolved);
}
