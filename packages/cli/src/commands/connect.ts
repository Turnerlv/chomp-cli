/**
 * @fileoverview Master Tether (`chomp connect`) command for switching the active Chomp target
 * repository across the machine without installing `@chomp/cli` into external `package.json` files.
 *
 * Updates `~/.chomp/context.json` so both the global MCP server (`chomp-server`) and the
 * running Visualizer (`chomp ui`) immediately switch to the connected repository.
 * Also ensures the global `~/.local/bin/chomp` and `~/.local/bin/chomp-research` shims are installed.
 *
 * @module @chomp/cli/commands/connect
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { ansi, printChompBanner, scaffoldDesignSystemConfig } from "../utils/branding.js";
import {
  ensureGitExcludeHasChomp,
  getChompMasterRoot,
  getGlobalContextPath,
  installGlobalChompShims,
  listKnownTargetRepos,
  readMasterContext,
  resolveGitRepoRoot,
  resolveRepoName,
  setActiveChompTarget,
} from "../utils/masterContext.js";
import { runAnalyze } from "./analyze.js";
import { runHealthCheck } from "./health.js";
import { installGitHooks, runInitWizard } from "./init.js";

function looksLikeGitUrlOrSlug(input: string): { isRemote: boolean; cloneUrl: string; repoName: string } {
  const trimmed = input.trim();
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(trimmed)) {
    const clean = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
    const repoName = clean.split("/").pop()?.split(":").pop() || "cloned-repo";
    return { isRemote: true, cloneUrl: trimmed, repoName };
  }
  if (/^gh:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/i.test(trimmed)) {
    const slug = trimmed.slice(3);
    const repoName = slug.split("/")[1];
    return {
      isRemote: true,
      cloneUrl: `https://github.com/${slug}.git`,
      repoName,
    };
  }
  if (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) &&
    !trimmed.startsWith(".") &&
    !existsSync(resolve(process.env.INIT_CWD ?? process.cwd(), trimmed))
  ) {
    const repoName = trimmed.split("/")[1].replace(/\.git$/i, "");
    return {
      isRemote: true,
      cloneUrl: `https://github.com/${trimmed.replace(/\.git$/i, "")}.git`,
      repoName,
    };
  }
  return { isRemote: false, cloneUrl: "", repoName: "" };
}

function resolveConnectTarget(
  inputTarget: string,
  baseDir: string,
): { repoPath: string; freshlyCloned: boolean } {
  const masterRoot = getChompMasterRoot();
  const trimmed = inputTarget.trim();

  if (trimmed === "chomp" || trimmed === "master") {
    return { repoPath: masterRoot, freshlyCloned: false };
  }

  // 1. Direct local path relative to caller's working directory
  const localCandidate = resolve(baseDir, trimmed);
  if (existsSync(localCandidate)) {
    return {
      repoPath: resolveGitRepoRoot(localCandidate),
      freshlyCloned: false,
    };
  }

  // 2. Short name inside fixtures/cloned-repos/<name> or fixtures/test-repos/<name>
  const clonedCandidate = resolve(masterRoot, "fixtures", "cloned-repos", trimmed);
  if (existsSync(clonedCandidate)) {
    return {
      repoPath: resolveGitRepoRoot(clonedCandidate),
      freshlyCloned: false,
    };
  }

  const testRepoCandidate = resolve(masterRoot, "fixtures", "test-repos", trimmed);
  if (existsSync(testRepoCandidate)) {
    return {
      repoPath: testRepoCandidate,
      freshlyCloned: false,
    };
  }

  // 3. Match against recentRepos by name or id
  const ctx = readMasterContext();
  const recentMatch = (ctx?.recentRepos ?? []).find(
    (r) =>
      r.name.toLowerCase() === trimmed.toLowerCase() ||
      r.id.toLowerCase() === trimmed.toLowerCase(),
  );
  if (recentMatch && existsSync(recentMatch.path)) {
    return {
      repoPath: recentMatch.path,
      freshlyCloned: false,
    };
  }

  // 4. Remote Git URL or GitHub owner/repo slug -> clone into fixtures/cloned-repos/<repoName>
  const remoteSpec = looksLikeGitUrlOrSlug(trimmed);
  if (remoteSpec.isRemote) {
    const clonedDir = resolve(
      masterRoot,
      "fixtures",
      "cloned-repos",
      remoteSpec.repoName,
    );
    if (existsSync(clonedDir)) {
      console.log(
        `  ${ansi.green("✓")} Found existing clone at ${ansi.cyan(clonedDir)}`,
      );
      return { repoPath: clonedDir, freshlyCloned: false };
    }
    mkdirSync(resolve(masterRoot, "fixtures", "cloned-repos"), {
      recursive: true,
    });
    console.log(
      `  ${ansi.cyan("⬇")} Cloning ${ansi.bold(remoteSpec.cloneUrl)} into ${ansi.cyan(clonedDir)}...`,
    );
    execSync(`git clone --depth 50 "${remoteSpec.cloneUrl}" "${clonedDir}"`, {
      stdio: "inherit",
    });
    return { repoPath: clonedDir, freshlyCloned: true };
  }

  throw new Error(
    `Could not resolve target '${inputTarget}'. Pass a local path, a repo name in fixtures/cloned-repos/, 'chomp', or a Git URL / owner/repo slug.`,
  );
}

function printMasterStatus(): void {
  const shims = installGlobalChompShims();
  const ctx = readMasterContext();
  const known = listKnownTargetRepos();

  console.log(
    `\n  ${ansi.yellowBold("⚡")} ${ansi.bold("Chomp Master Tether & Global CLI")}`,
  );
  console.log(
    `  ${ansi.dim("Global CLI Shims:")} ${ansi.cyan(shims.chompBin)}  ${ansi.dim("·")}  ${ansi.cyan(shims.researchBin)}`,
  );
  console.log(
    `  ${ansi.dim("Tether State:")}     ${ansi.cyan(getGlobalContextPath())}`,
  );

  if (ctx?.activeRepoPath) {
    console.log(
      `  ${ansi.green("●")} ${ansi.bold("Active Target:")}    ${ansi.yellowBold(ctx.activeRepoName)} ${ansi.dim(`(${ctx.activeRepoId})`)} → ${ansi.cyan(ctx.activeRepoPath)}`,
    );
  } else {
    console.log(
      `  ${ansi.yellow("○")} ${ansi.bold("Active Target:")}    ${ansi.dim("None set (defaults to Chomp master repo)")}`,
    );
  }

  console.log(`\n  ${ansi.bold("Known & Cloned Target Repositories:")}`);
  for (const repo of known) {
    const activeBadge = repo.isActive
      ? `${ansi.green("● ACTIVE")} `
      : `  ${ansi.dim("○")}      `;
    const dbBadge = repo.hasGraphDb
      ? ansi.green("[graph.db ready]")
      : ansi.dim("[not analyzed]");
    const sourceBadge =
      repo.source === "master"
        ? ansi.yellow("[master]")
        : repo.source === "cloned-fixture"
          ? ansi.cyan("[fixtures/cloned-repos]")
          : ansi.dim("[external]");
    console.log(
      `  ${activeBadge}${ansi.bold(repo.name.padEnd(20))} ${sourceBadge.padEnd(32)} ${dbBadge}  ${ansi.dim(repo.path)}`,
    );
  }

  console.log(`\n  ${ansi.dim("Quick Commands (work from any directory on your machine):")}`);
  console.log(`    ${ansi.cyan("chomp connect .")}                  ${ansi.dim("Tether current directory to MCP & Visualizer (stealth mode)")}`);
  console.log(`    ${ansi.cyan("chomp connect <name|path|url>")}    ${ansi.dim("Clone/connect repo & hot-switch MCP + Visualizer")}`);
  console.log(`    ${ansi.cyan("chomp connect chomp")}              ${ansi.dim("Switch tether back to the Chomp master repository")}`);
  console.log(`    ${ansi.cyan("chomp init")}                       ${ansi.dim("Run the full 60s interactive setup wizard in any repo")}\n`);
}

export function registerConnectCommand(program: Command): void {
  program
    .command("connect [target]")
    .description(
      "Tether the global Chomp MCP server & Visualizer to any local or cloned repository (or install global CLI shims)",
    )
    .option("-l, --list", "List active Master Tether status and known target repositories", false)
    .option(
      "--init",
      "Run the full interactive 'chomp init' setup wizard on the target repository",
      false,
    )
    .option(
      "--stealth",
      "Keep target repo 100% git-clean (.chomp/ hidden in .git/info/exclude; zero tracked file edits)",
      true,
    )
    .option(
      "-a, --analyze",
      "Force a fresh AST extraction even if .chomp/graph.db already exists",
      false,
    )
    .option(
      "--no-hooks",
      "Do not install background Git hooks (post-commit, post-merge, post-checkout) in the target repo",
    )
    .option(
      "--health",
      "Run the 4-metric Chomp structural health check after connecting",
      false,
    )
    .option(
      "-m, --measure",
      "Run 'chomp-research ledger pattern measure' against the connected repository",
      false,
    )
    .option("-y, --yes", "Accept recommended defaults when combined with --init", false)
    .action(
      async (
        inputTarget: string | undefined,
        options: {
          list?: boolean;
          init?: boolean;
          stealth?: boolean;
          analyze?: boolean;
          hooks?: boolean;
          health?: boolean;
          measure?: boolean;
          yes?: boolean;
        },
      ) => {
        // Always ensure ~/.local/bin/chomp and ~/.local/bin/chomp-research are up to date
        installGlobalChompShims();

        const baseDir = process.env.INIT_CWD ?? process.cwd();

        if (options.list) {
          printMasterStatus();
          return;
        }

        // If no target argument was passed:
        // - If the user is in a directory outside the currently tethered repo, connect `.`
        // - Otherwise, print the Master Tether status & known repos table
        if (!inputTarget) {
          const currentRepoRoot = resolveGitRepoRoot(baseDir);
          const ctx = readMasterContext();
          if (
            ctx?.activeRepoPath &&
            resolve(ctx.activeRepoPath) === resolve(currentRepoRoot)
          ) {
            printMasterStatus();
            return;
          }
          inputTarget = ".";
        }

        let resolved: { repoPath: string; freshlyCloned: boolean };
        try {
          resolved = resolveConnectTarget(inputTarget, baseDir);
        } catch (err: any) {
          console.error(`\n  ${ansi.red("✖")} ${err.message}\n`);
          process.exit(1);
        }

        const { repoPath, freshlyCloned } = resolved;
        const repoName = resolveRepoName(repoPath);

        if (options.init) {
          await runInitWizard(repoPath, {
            yes: options.yes,
            stealth: false,
          });
          return;
        }

        printChompBanner(
          `Connecting Master Tether → ${repoName} (${repoPath})`,
          "open",
        );

        // 1. Hide .chomp/ in .git/info/exclude so the target repo stays 100% git-clean
        const excluded = ensureGitExcludeHasChomp(repoPath);
        if (excluded) {
          console.log(
            `  ${ansi.green("✓")} Added ${ansi.cyan(".chomp/")} to ${ansi.cyan(".git/info/exclude")} (stealth mode — zero .gitignore changes)`,
          );
        } else {
          console.log(
            `  ${ansi.green("✓")} Verified ${ansi.cyan(".chomp/")} is ignored by Git`,
          );
        }

        // 2. Install background Git hooks (post-commit, post-merge, post-checkout) inside .git/hooks
        if (options.hooks !== false) {
          const hookRes = installGitHooks(repoPath);
          if (hookRes.files.length > 0) {
            console.log(
              `  ${ansi.green("✓")} Installed background Git sync hooks (${hookRes.files.join(", ")})`,
            );
          } else if (hookRes.mode !== "none") {
            console.log(
              `  ${ansi.green("✓")} Background Git sync hooks (${hookRes.mode}) active`,
            );
          }
        }

        // 2b. Scaffold starter `designSystem` config when frontend packages are detected
        // (writes `.chomp/plugins/design-system/config.json` in stealth mode so git stays 100% clean)
        const dsScaffold = scaffoldDesignSystemConfig(repoPath, {
          stealth: options.stealth !== false,
        });
        if (dsScaffold.written && dsScaffold.configRelPath) {
          console.log(
            `  ${ansi.green("✓")} Scaffolded ${ansi.cyan("designSystem")} config in ${ansi.cyan(dsScaffold.configRelPath)} (${dsScaffold.frontendPackages.join(", ")})`,
          );
        }

        // 3. Extract .chomp/graph.db if missing, freshly cloned, or --analyze requested
        const dbPath = resolve(repoPath, ".chomp", "graph.db");
        if (!existsSync(dbPath) || freshlyCloned || options.analyze) {
          await runAnalyze(repoPath);
        } else {
          console.log(
            `  ${ansi.green("✓")} Existing graph ready at ${ansi.cyan(dbPath)} ${ansi.dim("(pass --analyze to re-extract)")}`,
          );
        }

        // 4. Lock Master Tether in ~/.chomp/context.json
        const updatedCtx = setActiveChompTarget(repoPath);
        console.log(
          `\n  ${ansi.green("⚡")} ${ansi.bold("Master Tether Locked:")} ${ansi.yellowBold(updatedCtx.activeRepoName)} ${ansi.dim(`(${updatedCtx.activeRepoId})`)}`,
        );
        console.log(
          `    ${ansi.dim("•")} ${ansi.bold("MCP Server (chomp-server):")} Dynamically routed to ${ansi.cyan(dbPath)}`,
        );
        console.log(
          `    ${ansi.dim("•")} ${ansi.bold("Visualizer (chomp ui):")}     Auto-switched to ${ansi.cyan(repoPath)}\n`,
        );

        // 5. Optional health check or pattern ledger measurement
        if (options.health || freshlyCloned) {
          runHealthCheck(repoPath);
        }

        if (options.measure) {
          const researchBin = resolve(
            getChompMasterRoot(),
            "packages/db/node_modules/.bin/tsx",
          );
          const researchEntry = resolve(
            getChompMasterRoot(),
            "fixtures/research/research-cli/src/index.ts",
          );
          if (existsSync(researchBin) && existsSync(researchEntry)) {
            console.log(
              `\n  ${ansi.cyan("📊")} Running pattern ledger measurement for ${ansi.bold(repoName)}...\n`,
            );
            try {
              execSync(
                `"${researchBin}" "${researchEntry}" ledger pattern measure --repo "${repoPath}"`,
                { cwd: getChompMasterRoot(), stdio: "inherit" },
              );
            } catch {
              // non-fatal if ledger measure exits non-zero
            }
          }
        }
      },
    );
}
