#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  createDefaultConfig,
  detectRepository,
  runDoctor,
  serializeConfig,
  type RepositoryDetection,
} from "@llmatic/core";

const program = new Command();

function printDetection(detection: RepositoryDetection): void {
  console.log("Repository: " + detection.root);
  console.log("Git: " + (detection.git ? "yes" : "no"));
  console.log("Package manager: " + detection.packageManager);
  console.log(
    "Technologies: " + (detection.technologies.length ? detection.technologies.join(", ") : "none"),
  );
  console.log("Capabilities:");

  for (const capability of detection.capabilities) {
    const marker = capability.available ? "✓" : "·";
    const command = capability.command ? " -> " + capability.command : "";
    console.log("  " + marker + " " + capability.name + command);
  }
}

program
  .name("llmatic")
  .description("Universal local software-engineering runtime for coding agents.")
  .version("0.1.0");

program
  .command("detect")
  .description("Detect repository technologies and executable engineering capabilities.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { root: string; json?: boolean }) => {
    const detection = await detectRepository(resolve(options.root));

    if (options.json) {
      console.log(JSON.stringify(detection, null, 2));
      return;
    }

    printDetection(detection);
  });

program
  .command("init")
  .description("Initialize LLMatic runtime configuration in a repository.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .action(async (options: { root: string }) => {
    const root = resolve(options.root);
    const detection = await detectRepository(root);
    const config = createDefaultConfig(detection);

    await mkdir(resolve(root, ".llmatic/state"), { recursive: true });
    await mkdir(resolve(root, ".llmatic/cache"), { recursive: true });

    await writeFile(resolve(root, ".llmatic/.gitignore"), "*\n!.gitignore\n", {
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });

    await writeFile(resolve(root, "llmatic.agent.yaml"), serializeConfig(config), {
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw new Error("llmatic.agent.yaml already exists; refusing to overwrite it.");
      }
      throw error;
    });

    console.log("LLMatic Agent Runtime initialized.");
    console.log("");
    printDetection(detection);
    console.log("");
    console.log("Created: llmatic.agent.yaml");
    console.log("Created: .llmatic/");
  });

program
  .command("doctor")
  .description("Validate the local runtime, repository, and required toolchain.")
  .option("-r, --root <path>", "Repository root", process.cwd())
  .action(async (options: { root: string }) => {
    const report = await runDoctor(resolve(options.root));

    console.log("LLMatic Agent Runtime Doctor");
    console.log("Repository: " + report.root);
    console.log("");

    for (const item of report.checks) {
      console.log("[" + item.status + "] " + item.name + ": " + item.detail);
    }

    console.log("");
    console.log(report.ready ? "READY" : "NOT READY");

    if (!report.ready) {
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("llmatic: " + message);
  process.exitCode = 1;
});
