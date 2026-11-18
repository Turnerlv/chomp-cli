import { Command } from "commander";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ansi } from "../utils/branding.js";
import {
  getChompMasterRoot,
  readMasterContext,
  setActiveChompTarget,
} from "../utils/masterContext.js";

const HOOK_FILES = [
  ".husky/post-commit",
  ".husky/post-merge",
  ".husky/post-checkout",
  ".husky/pre-commit",
  ".git/hooks/post-commit",
  ".git/hooks/post-merge",
  ".git/hooks/post-checkout",
  ".git/hooks/pre-commit",
];

const RULE_FILES = [
  ".cursorrules",
  ".windsurfrules",
  "AGENTS.md",
  "CLAUDE.md",
  ".kiro/steering/chomp-architecture.md",
];
const MCP_FILES = [
  ".cursor/mcp.json",
  ".mcp.json",
  ".kiro/settings/mcp.json",
];

function isDefaultKiroSteeringRemainder(text: string): boolean {
  const withoutFrontmatter = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/^#\s+Chomp Architecture & Structural Navigation\s*$/m, "")
    .trim();
  return withoutFrontmatter.length === 0;
}

function pruneEmptyDir(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  try {
    if (!statSync(dirPath).isDirectory()) return false;
    const entries = readdirSync(dirPath);
    if (entries.length === 0) {
      rmdirSync(dirPath);
      return true;
    }
  } catch {
    // Ignore filesystem errors
  }
  return false;
}

function resolveGitExcludePaths(repoRoot: string): string[] {
  const dotGit = resolve(repoRoot, ".git");
  if (!existsSync(dotGit)) return [];
  const candidates = new Set<string>();
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      candidates.add(resolve(dotGit, "info", "exclude"));
    } else {
      const pointer = readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(pointer);
      if (match) {
        const gitDir = resolve(repoRoot, match[1].trim());
        candidates.add(resolve(gitDir, "info", "exclude"));
        const commondirFile = resolve(gitDir, "commondir");
        if (existsSync(commondirFile)) {
          const commonRel = readFileSync(commondirFile, "utf8").trim();
          if (commonRel) {
            candidates.add(resolve(gitDir, commonRel, "info", "exclude"));
          }
        }
      }
    }
  } catch {
    // Ignore
  }
  return [...candidates];
}

export function runUninstall(
  inputPath?: string,
  options?: { quiet?: boolean },
): { removed: string[]; updated: string[] } {
  const quiet = Boolean(options?.quiet);
  const log = (msg: string) => {
    if (!quiet) console.log(msg);
  };
  const removed: string[] = [];
  const updated: string[] = [];

  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const cwd = resolve(baseDir, inputPath ?? ".");
  const chompDir = resolve(cwd, ".chomp");

  if (existsSync(chompDir)) {
    rmSync(chompDir, { recursive: true, force: true });
    removed.push(".chomp/");
    log(`  ${ansi.green("✓")} Removed ${ansi.cyan(".chomp/")}`);
  }

  // 1. Strip Chomp Harness blocks from rule & steering files
  const harnessRegex =
    /# --- BEGIN CHOMP HARNESS ---\r?\n[\s\S]*?# --- END CHOMP HARNESS ---\r?\n?/g;

  for (const file of RULE_FILES) {
    const filePath = resolve(cwd, file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      if (content.includes("# --- BEGIN CHOMP HARNESS ---")) {
        const newContent = content.replace(harnessRegex, "").trim();
        const isEmptySteering =
          file === ".kiro/steering/chomp-architecture.md" &&
          isDefaultKiroSteeringRemainder(newContent);
        if (newContent === "" || isEmptySteering) {
          unlinkSync(filePath);
          removed.push(file);
          log(`  ${ansi.green("✓")} Removed ${ansi.cyan(file)}`);
        } else {
          writeFileSync(filePath, newContent + "\n", "utf8");
          updated.push(file);
          log(
            `  ${ansi.green("✓")} Stripped Chomp Harness from ${ansi.cyan(file)}`,
          );
        }
      }
    }
  }

  // 2. Remove Kiro hook & Power bundle if present
  const kiroHookRel = ".kiro/hooks/chomp-sync.kiro.hook";
  const kiroHookPath = resolve(cwd, kiroHookRel);
  if (existsSync(kiroHookPath)) {
    unlinkSync(kiroHookPath);
    removed.push(kiroHookRel);
    log(`  ${ansi.green("✓")} Removed ${ansi.cyan(kiroHookRel)}`);
  }

  const kiroPowerRel = ".kiro/powers/chomp";
  const kiroPowerPath = resolve(cwd, kiroPowerRel);
  if (existsSync(kiroPowerPath)) {
    rmSync(kiroPowerPath, { recursive: true, force: true });
    removed.push(kiroPowerRel);
    log(`  ${ansi.green("✓")} Removed ${ansi.cyan(kiroPowerRel)}`);
  }

  // 3. Strip Chomp Hook blocks from .husky/ and .git/hooks/
  const hookRegex =
    /# --- BEGIN CHOMP HOOK ---\r?\n[\s\S]*?# --- END CHOMP HOOK ---\r?\n?/g;

  for (const relHook of HOOK_FILES) {
    const hookPath = resolve(cwd, relHook);
    if (existsSync(hookPath)) {
      const content = readFileSync(hookPath, "utf8");
      if (content.includes("# --- BEGIN CHOMP HOOK ---")) {
        const newContent = content.replace(hookRegex, "").trim();
        if (
          newContent === "" ||
          newContent === "#!/bin/sh" ||
          newContent === "#!/usr/bin/env sh"
        ) {
          unlinkSync(hookPath);
          removed.push(relHook);
          log(
            `  ${ansi.green("✓")} Removed Chomp hook ${ansi.cyan(relHook)}`,
          );
        } else {
          writeFileSync(hookPath, newContent + "\n", "utf8");
          updated.push(relHook);
          log(
            `  ${ansi.green("✓")} Stripped Chomp hook block from ${ansi.cyan(relHook)}`,
          );
        }
      }
    }
  }

  // 4. Remove chomp-server from workspace MCP config files (.cursor/mcp.json, .mcp.json, .kiro/settings/mcp.json)
  for (const relMcp of MCP_FILES) {
    const mcpPath = resolve(cwd, relMcp);
    if (existsSync(mcpPath)) {
      try {
        const parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
        if (parsed?.mcpServers?.["chomp-server"]) {
          delete parsed.mcpServers["chomp-server"];
          const remainingKeys = Object.keys(parsed.mcpServers);
          if (remainingKeys.length === 0 && Object.keys(parsed).length === 1) {
            unlinkSync(mcpPath);
            removed.push(relMcp);
            log(
              `  ${ansi.green("✓")} Removed empty ${ansi.cyan(relMcp)}`,
            );
          } else {
            writeFileSync(
              mcpPath,
              JSON.stringify(parsed, null, 2) + "\n",
              "utf8",
            );
            updated.push(relMcp);
            log(
              `  ${ansi.green("✓")} Removed chomp-server from ${ansi.cyan(relMcp)}`,
            );
          }
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  // Prune empty IDE directories (.kiro/*, .kiro, .cursor)
  for (const relDir of [
    ".kiro/settings",
    ".kiro/steering",
    ".kiro/hooks",
    ".kiro/powers",
    ".kiro",
    ".cursor",
  ]) {
    pruneEmptyDir(resolve(cwd, relDir));
  }

  // 5. Clean up Chomp block in .gitignore and .git/info/exclude
  const ignoreRegex =
    /\n?# --- BEGIN CHOMP IGNORE ---\r?\n[\s\S]*?# --- END CHOMP IGNORE ---\r?\n?/g;
  const gitignorePath = resolve(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, "utf8");
    if (gitignoreContent.includes("# --- BEGIN CHOMP IGNORE ---")) {
      const cleaned = gitignoreContent.replace(ignoreRegex, "\n").trimEnd();
      writeFileSync(gitignorePath, cleaned ? cleaned + "\n" : "", "utf8");
      updated.push(".gitignore");
      log(`  ${ansi.green("✓")} Cleaned up ${ansi.cyan(".gitignore")}`);
    }
  }

  for (const gitExcludePath of resolveGitExcludePaths(cwd)) {
    if (existsSync(gitExcludePath)) {
      const excludeContent = readFileSync(gitExcludePath, "utf8");
      if (excludeContent.includes("# --- BEGIN CHOMP IGNORE ---")) {
        const cleaned = excludeContent.replace(ignoreRegex, "\n").trimEnd();
        writeFileSync(gitExcludePath, cleaned ? cleaned + "\n" : "", "utf8");
        updated.push(".git/info/exclude");
        log(`  ${ansi.green("✓")} Cleaned up ${ansi.cyan(".git/info/exclude")}`);
      }
    }
  }

  // 6. If this repo was the active Master Tether, reset tether back to Chomp master
  const ctx = readMasterContext();
  if (ctx?.activeRepoPath && resolve(ctx.activeRepoPath) === resolve(cwd)) {
    const masterRoot = getChompMasterRoot();
    if (resolve(masterRoot) !== resolve(cwd)) {
      setActiveChompTarget(masterRoot);
      log(
        `  ${ansi.green("✓")} Switched Master Tether back to ${ansi.cyan(masterRoot)}`,
      );
    }
  }

  log(
    `\n  ${ansi.yellowBold("◆")} ${ansi.bold("Chomp has been cleanly removed. We left no trace.")}\n`,
  );

  return { removed, updated };
}

export function registerUninstallCommand(program: Command) {
  program
    .command("uninstall [path]")
    .description(
      "Cleanly remove Chomp (.chomp/, agent harnesses, MCP entries, and git hooks) from the workspace.",
    )
    .action((inputPath?: string) => {
      runUninstall(inputPath);
    });
}
