import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureGlobalKiloMcpServer,
  kiloGlobalConfigPath,
  readGlobalKiloLlmaticServer,
  isGlobalKiloLlmaticServerHealthy,
} from "../src/kilo.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Kilo connector", () => {
  it("adds the global LLMatic MCP server while preserving JSONC comments and other servers", async () => {
    const home = await mkdtemp(join(tmpdir(), "llmatic-kilo-"));
    temporaryDirectories.push(home);

    const configPath = kiloGlobalConfigPath(home);
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(
      configPath,
      [
        "{",
        "  // keep this user comment",
        '  "mcp": {',
        '    "existing": { "type": "remote", "url": "https://example.test/mcp" }',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await ensureGlobalKiloMcpServer({
      homeDirectory: home,
      serverPath: join(home, "runtime", "mcp-server.mjs"),
      llmaticHome: join(home, "llmatic-storage"),
      nodeCommand: "node",
    });

    expect(result.changed).toBe(true);

    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain("// keep this user comment");
    expect(raw).toContain('"existing"');
    expect(raw).toContain('"llmatic"');
    expect(raw).toContain('"LLMATIC_HOME"');

    const server = await readGlobalKiloLlmaticServer(home);
    expect(server).toMatchObject({
      type: "local",
      enabled: true,
      timeout: 30000,
    });

    const second = await ensureGlobalKiloMcpServer({
      homeDirectory: home,
      serverPath: join(home, "runtime", "mcp-server.mjs"),
      llmaticHome: join(home, "llmatic-storage"),
      nodeCommand: "node",
    });
    expect(second.changed).toBe(false);
    expect(
      isGlobalKiloLlmaticServerHealthy(server, {
        serverPath: join(home, "runtime", "mcp-server.mjs"),
        llmaticHome: join(home, "llmatic-storage"),
        nodeCommand: "node",
      }),
    ).toBe(true);
  });
});
