import { Command } from "commander";
import { CORE_EXTRACTOR_VERSION, analyzeTarget } from "@chomp/core";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  ansi,
  confirmPrompt,
  detectWorkspacePackages,
  loadExcludeWorkspaces,
  multiSelectPrompt,
  playChompBannerAnimation,
  printChompBanner,
  printDetectedWorkspaceTable,
  printWelcomeMessage,
  runChompExtractionWithAnimation,
  runDiscoveryTicker,
  saveExcludeWorkspaces,
  scaffoldDesignSystemConfig,
} from "../utils/branding.js";
import { getGitInfo, resolveRepoName } from "../utils/git.js";
import {
  ensureGitExcludeHasChomp,
  getChompMasterRoot,
  installGlobalChompShims,
  setActiveChompTarget,
} from "../utils/masterContext.js";
import { runAnalyze } from "./analyze.js";
import { startUiServer } from "./ui.js";

export const HARNESS_TEXT =
  `
# --- BEGIN CHOMP HARNESS ---
You are operating in a Chomp-enabled workspace. DO NOT use grep, find, or blind file-reading to understand the system architecture. You must use Map-First Navigation and Query-Scoped Active Views:
1. Resolve target node IDs with chomp_get_nodes (using search_term / packageName) BEFORE reading source files. When the user is asking an architectural question, querying how a flow works, or requesting a visual walkthrough, IMMEDIATELY call chomp_create_view (passing viewLevel: "system" | "package") to highlight the active subsystem in the UI and share the returned one-click viewUrl markdown link in your response. Do NOT call chomp_create_view on routine coding or implementation prompts.
2. Use chomp_get_blast_radius (with create_view: false during coding tasks, or create_view: true when answering impact questions) BEFORE editing any contract or class to inspect upstream callers, downstream dependencies, and Port Valve schemas, and use chomp_get_edges to trace execution paths.
3. Use chomp_audit_health, chomp_find_redundancies, and chomp_check_boundaries to diagnose unresolved call hotspots, pass-through middlemen, duplicate sequences, and boundary violations. Use chomp_get_conventions to align code or chomp.config.json#conventions to paved-road AST conventions, and chomp_local_shims for runtime/DI L1_SHIMS bridges.
4. Use chomp_get_diff to verify the architectural blast radius of your code changes BEFORE you finish your task. Code is ephemeral; the Graph is the truth. Read the graph first.
# --- END CHOMP HARNESS ---
`.trim() + "\n";

export const CHOMP_HOOK_BLOCK =
  `
# --- BEGIN CHOMP HOOK ---
# Automatically keep .chomp/graph.db in sync after git operations (non-blocking)
if [ -x "$HOME/.local/bin/chomp" ]; then
  "$HOME/.local/bin/chomp" analyze . --quiet >/dev/null 2>&1 || true
elif command -v chomp >/dev/null 2>&1; then
  chomp analyze . --quiet >/dev/null 2>&1 || true
elif command -v pnpm >/dev/null 2>&1 && grep -q '"chomp":' package.json 2>/dev/null; then
  pnpm chomp analyze . --quiet >/dev/null 2>&1 || true
else
  npx --no-install chomp analyze . --quiet >/dev/null 2>&1 || true
fi
# --- END CHOMP HOOK ---
`.trim() + "\n";

const GIT_HOOK_NAMES = ["post-commit", "post-merge", "post-checkout"] as const;

function ensureGitignoreHasChomp(repoRoot: string): boolean {
  const gitignorePath = resolve(repoRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (
      lines.includes(".chomp") ||
      lines.includes(".chomp/") ||
      lines.includes("/.chomp") ||
      lines.includes("/.chomp/")
    ) {
      return false;
    }
    const sep = content.endsWith("\n") || content.length === 0 ? "" : "\n";
    writeFileSync(
      gitignorePath,
      `${content}${sep}\n# --- BEGIN CHOMP IGNORE ---\n.chomp/\n# --- END CHOMP IGNORE ---\n`,
      "utf8",
    );
    return true;
  } else {
    writeFileSync(
      gitignorePath,
      `# --- BEGIN CHOMP IGNORE ---\n.chomp/\n# --- END CHOMP IGNORE ---\n`,
      "utf8",
    );
    return true;
  }
}

export function installGitHooks(repoRoot: string): {
  mode: "husky" | "git-hooks" | "none";
  files: string[];
} {
  const huskyDir = resolve(repoRoot, ".husky");
  const gitHooksDir = resolve(repoRoot, ".git", "hooks");

  const useHusky = existsSync(huskyDir);
  const targetDir = useHusky
    ? huskyDir
    : existsSync(resolve(repoRoot, ".git"))
      ? gitHooksDir
      : null;

  if (!targetDir) {
    return { mode: "none", files: [] };
  }

  if (!existsSync(targetDir)) {
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch {
      return { mode: "none", files: [] };
    }
  }

  // If a legacy .husky/pre-commit had a bare `pnpm chomp analyze .`, remove that line
  // so commits are never slowed down or spammed by pre-commit extraction.
  const legacyPreCommit = resolve(targetDir, "pre-commit");
  if (existsSync(legacyPreCommit)) {
    try {
      const rawPre = readFileSync(legacyPreCommit, "utf8");
      const cleanedLines = rawPre
        .split(/\r?\n/)
        .filter((line) => !/^\s*(pnpm|npx)\s+chomp\s+analyze\b/.test(line));
      const cleaned = cleanedLines.join("\n").trim();
      if (cleaned !== rawPre.trim()) {
        if (!cleaned || cleaned === "#!/bin/sh" || cleaned === "#!/usr/bin/env sh") {
          unlinkSync(legacyPreCommit);
        } else {
          writeFileSync(legacyPreCommit, cleaned + "\n", "utf8");
        }
      }
    } catch {
      // ignore if hook dir is write-protected
    }
  }

  const updatedFiles: string[] = [];
  const hookBlockRegex =
    /# --- BEGIN CHOMP HOOK ---\r?\n[\s\S]*?# --- END CHOMP HOOK ---\r?\n?/;
  for (const hookName of GIT_HOOK_NAMES) {
    const hookPath = resolve(targetDir, hookName);
    let content = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";
    try {
      if (!content.includes("# --- BEGIN CHOMP HOOK ---")) {
        const prefix =
          content.trim().length > 0
            ? content.trimEnd() + "\n\n"
            : useHusky
              ? ""
              : "#!/bin/sh\n\n";
        writeFileSync(hookPath, prefix + CHOMP_HOOK_BLOCK, "utf8");
        try {
          chmodSync(hookPath, 0o755);
        } catch {
          // ignore chmod errors on Windows
        }
        updatedFiles.push(useHusky ? `.husky/${hookName}` : `.git/hooks/${hookName}`);
      } else if (!content.includes("$HOME/.local/bin/chomp")) {
        const upgraded = content.replace(hookBlockRegex, CHOMP_HOOK_BLOCK);
        writeFileSync(hookPath, upgraded, "utf8");
        try {
          chmodSync(hookPath, 0o755);
        } catch {
          // ignore chmod errors on Windows
        }
        updatedFiles.push(useHusky ? `.husky/${hookName}` : `.git/hooks/${hookName}`);
      }
    } catch {
      // ignore EPERM if running inside a write-protected sandbox
    }
  }

  return {
    mode: useHusky ? "husky" : "git-hooks",
    files: updatedFiles,
  };
}

export const KIRO_AUTO_APPROVE_TOOLS = [
  "chomp_get_nodes",
  "chomp_get_edges",
  "chomp_get_diff",
  "chomp_create_view",
  "chomp_visualizer_audit",
  "chomp_audit_health",
  "chomp_find_redundancies",
  "chomp_check_boundaries",
  "chomp_get_blast_radius",
] as const;

export const KIRO_STEALTH_EXCLUDE_ENTRIES = [
  ".kiro/settings/mcp.json",
  ".kiro/steering/chomp-architecture.md",
  ".kiro/hooks/chomp-sync.kiro.hook",
  ".kiro/powers/chomp/",
] as const;

export interface AgentIntegrationSpec {
  id: "cursor" | "claude" | "antigravity" | "windsurf" | "kiro";
  label: string;
  hint: string;
  detected: boolean;
  ruleFile: string;
  mcpConfigPath?: string;
}

export function detectAgentIntegrations(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentIntegrationSpec[] {
  const cursorDir = resolve(repoRoot, ".cursor");
  const cursorRules = resolve(repoRoot, ".cursorrules");
  const claudeMd = resolve(repoRoot, "CLAUDE.md");
  const claudeMcp = resolve(repoRoot, ".mcp.json");
  const agentsMd = resolve(repoRoot, "AGENTS.md");
  const windsurfRules = resolve(repoRoot, ".windsurfrules");
  const kiroDir = resolve(repoRoot, ".kiro");
  const agyMcpConfig = resolve(
    homedir(),
    ".gemini",
    "antigravity",
    "mcp_config.json",
  );

  const cursorDetected = existsSync(cursorDir) || existsSync(cursorRules);
  const claudeDetected = existsSync(claudeMd) || existsSync(claudeMcp);
  const agyDetected =
    existsSync(agentsMd) ||
    existsSync(resolve(homedir(), ".gemini", "antigravity"));
  const windsurfDetected = existsSync(windsurfRules);
  const kiroDetected =
    existsSync(kiroDir) ||
    Boolean(env.KIRO_PID) ||
    Boolean(env.TERM_PROGRAM?.toLowerCase().includes("kiro"));

  const anyDetected =
    cursorDetected ||
    claudeDetected ||
    agyDetected ||
    windsurfDetected ||
    kiroDetected;

  return [
    {
      id: "cursor",
      label: "Cursor",
      hint: ".cursor/mcp.json + .cursorrules",
      detected: cursorDetected || !anyDetected,
      ruleFile: ".cursorrules",
      mcpConfigPath: resolve(repoRoot, ".cursor", "mcp.json"),
    },
    {
      id: "kiro",
      label: "Kiro",
      hint: ".kiro/settings/mcp.json + steering + hook + power",
      detected: kiroDetected,
      ruleFile: ".kiro/steering/chomp-architecture.md",
      mcpConfigPath: resolve(repoRoot, ".kiro", "settings", "mcp.json"),
    },
    {
      id: "claude",
      label: "Claude Code",
      hint: ".mcp.json + CLAUDE.md",
      detected: claudeDetected,
      ruleFile: "CLAUDE.md",
      mcpConfigPath: claudeMcp,
    },
    {
      id: "antigravity",
      label: "Antigravity / AGENTS.md",
      hint: "AGENTS.md + mcp_config.json",
      detected: agyDetected || !anyDetected,
      ruleFile: "AGENTS.md",
      mcpConfigPath: existsSync(dirname(agyMcpConfig))
        ? agyMcpConfig
        : undefined,
    },
    {
      id: "windsurf",
      label: "Windsurf",
      hint: ".windsurfrules",
      detected: windsurfDetected,
      ruleFile: ".windsurfrules",
    },
  ];
}

function buildChompMcpServerEntry(
  repoRoot: string,
  options?: { kiro?: boolean },
): Record<string, unknown> {
  const localMcpDist = resolve(repoRoot, "packages/mcp/dist/index.js");
  const globalChompBin = resolve(homedir(), ".local", "bin", "chomp");
  const masterRoot = getChompMasterRoot();
  const masterTsx = resolve(masterRoot, "packages/db/node_modules/.bin/tsx");
  const masterCliEntry = resolve(masterRoot, "packages/cli/src/index.ts");

  let baseEntry: { command: string; args: string[] };
  if (existsSync(localMcpDist)) {
    baseEntry = {
      command: "node",
      args: [localMcpDist, repoRoot],
    };
  } else if (existsSync(globalChompBin)) {
    baseEntry = {
      command: globalChompBin,
      args: ["mcp", repoRoot],
    };
  } else if (existsSync(masterTsx) && existsSync(masterCliEntry)) {
    baseEntry = {
      command: masterTsx,
      args: [masterCliEntry, "mcp", repoRoot],
    };
  } else {
    baseEntry = {
      command: "npx",
      args: ["-y", "@chomp/cli", "mcp", repoRoot],
    };
  }

  if (options?.kiro) {
    return {
      ...baseEntry,
      disabled: false,
      autoApprove: [...KIRO_AUTO_APPROVE_TOOLS],
    };
  }
  return baseEntry;
}

export function upsertMcpServerConfig(
  mcpJsonPath: string,
  repoRoot: string,
  options?: { kiro?: boolean },
): boolean {
  try {
    let rootObj: Record<string, any> = {};
    if (existsSync(mcpJsonPath)) {
      try {
        rootObj = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
      } catch {
        return false;
      }
    }
    if (!rootObj.mcpServers || typeof rootObj.mcpServers !== "object") {
      rootObj.mcpServers = {};
    }
    // Preserve existing custom chomp-server config if already present
    if (rootObj.mcpServers["chomp-server"]) {
      return false;
    }

    rootObj.mcpServers["chomp-server"] = buildChompMcpServerEntry(
      repoRoot,
      options,
    );

    const parentDir = dirname(mcpJsonPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(mcpJsonPath, JSON.stringify(rootObj, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function installKiroIntegration(
  repoRoot: string,
  options?: { stealth?: boolean },
): {
  mcpUpdated: boolean;
  steeringUpdated: boolean;
  hookUpdated: boolean;
  powerUpdated: boolean;
} {
  const isStealth = Boolean(options?.stealth);
  const mcpPath = resolve(repoRoot, ".kiro", "settings", "mcp.json");
  const hadExistingMcpFile = existsSync(mcpPath);
  const mcpUpdated = upsertMcpServerConfig(mcpPath, repoRoot, { kiro: true });

  // 1. .kiro/steering/chomp-architecture.md with `inclusion: always` frontmatter
  const steeringPath = resolve(
    repoRoot,
    ".kiro",
    "steering",
    "chomp-architecture.md",
  );
  mkdirSync(dirname(steeringPath), { recursive: true });
  let steeringUpdated = false;
  const existingSteering = existsSync(steeringPath)
    ? readFileSync(steeringPath, "utf8")
    : "";
  if (!existingSteering.includes("# --- BEGIN CHOMP HARNESS ---")) {
    if (existingSteering.trim().length > 0) {
      writeFileSync(
        steeringPath,
        `${existingSteering.trimEnd()}\n\n${HARNESS_TEXT}`,
        "utf8",
      );
    } else {
      const steeringDoc =
        [
          "---",
          "inclusion: always",
          "---",
          "",
          "# Chomp Architecture & Structural Navigation",
          "",
          HARNESS_TEXT.trimEnd(),
        ].join("\n") + "\n";
      writeFileSync(steeringPath, steeringDoc, "utf8");
    }
    steeringUpdated = true;
  }

  // 2. .kiro/hooks/chomp-sync.kiro.hook
  const hookPath = resolve(
    repoRoot,
    ".kiro",
    "hooks",
    "chomp-sync.kiro.hook",
  );
  mkdirSync(dirname(hookPath), { recursive: true });
  const hookManifest = {
    enabled: true,
    name: "Chomp Structural Graph Sync",
    description:
      "Keep .chomp/graph.db synchronized when TypeScript or JavaScript source files are edited.",
    version: "1",
    when: {
      type: "fileEdited",
      patterns: ["**/*.{ts,tsx,js,jsx}"],
    },
    then: {
      type: "runCommand",
      command: "chomp analyze . --quiet",
    },
  };
  writeFileSync(hookPath, JSON.stringify(hookManifest, null, 2) + "\n", "utf8");
  const hookUpdated = true;

  // 3. .kiro/powers/chomp/POWER.md + .kiro/powers/chomp/mcp.json
  const powerDir = resolve(repoRoot, ".kiro", "powers", "chomp");
  mkdirSync(powerDir, { recursive: true });
  const powerMdPath = resolve(powerDir, "POWER.md");
  const powerMcpPath = resolve(powerDir, "mcp.json");
  const powerMd =
    [
      "---",
      'name: "chomp"',
      'displayName: "Chomp Software Representation"',
      'description: "Deterministic AST structural graph, blast-radius analysis, active walkthrough views, and architectural health intelligence for AI coding agents."',
      'keywords: ["architecture", "ast", "blast-radius", "graph", "mcp", "representation"]',
      "---",
      "",
      "# Chomp Software Representation Power",
      "",
      "Provides deterministic structural representation tools (`chomp-server`) for Map-First Navigation, Pre-Edit Blast Radius checks, Query-Scoped Active Views, and Post-Edit Verification.",
      "",
      "## Core Workflow",
      "",
      "1. **Map-First Navigation:** Call `chomp_get_nodes` (`search_term` / `packageName`) and `chomp_get_edges` before reading files.",
      "2. **Pre-Edit Blast Radius:** Call `chomp_get_blast_radius` (`create_view: false` during coding tasks) before modifying contracts or classes.",
      "3. **Query-Scoped Active Views:** Call `chomp_create_view` only when answering architectural questions or walkthrough requests.",
      "4. **Health & Boundaries:** Call `chomp_audit_health`, `chomp_find_redundancies`, and `chomp_check_boundaries` to surface structural hotspots.",
      "5. **Post-Edit Verification:** Call `chomp_get_diff` before completing code changes to verify structural blast radius.",
    ].join("\n") + "\n";
  writeFileSync(powerMdPath, powerMd, "utf8");
  writeFileSync(
    powerMcpPath,
    JSON.stringify(
      {
        mcpServers: {
          "chomp-server": buildChompMcpServerEntry(repoRoot, { kiro: true }),
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const powerUpdated = true;

  if (isStealth) {
    const excludeItems = KIRO_STEALTH_EXCLUDE_ENTRIES.filter(
      (entry) => !(entry === ".kiro/settings/mcp.json" && hadExistingMcpFile),
    );
    ensureGitExcludeHasChomp(repoRoot, [...excludeItems]);
  }

  return {
    mcpUpdated,
    steeringUpdated,
    hookUpdated,
    powerUpdated,
  };
}

function injectRuleHarness(repoRoot: string, ruleFile: string): boolean {
  const filePath = resolve(repoRoot, ruleFile);
  const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  if (
    content.includes("# --- BEGIN CHOMP HARNESS ---") ||
    content.includes("Software Representation Engine (`chomp`) — Agent Guidelines")
  ) {
    return false;
  }
  const separator = content.trim().length > 0 ? "\n\n" : "";
  writeFileSync(
    filePath,
    content.trim() + separator + HARNESS_TEXT,
    "utf8",
  );
  return true;
}

export interface InitWizardOptions {
  yes?: boolean;
  ui?: boolean;
  port?: string;
  logo?: boolean;
  dryRun?: boolean;
  sandbox?: boolean;
  stealth?: boolean;
}

export async function runInitWizard(
  inputPath: string | undefined,
  options: InitWizardOptions = {},
): Promise<void> {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const targetPath = resolve(baseDir, inputPath ?? ".");
  const repoName = resolveRepoName(targetPath);
  const isDryRun = Boolean(options.dryRun || options.sandbox);
  const isStealth = Boolean(options.stealth);

  // 0. Brand Banner (static Frame 1 on init; animation runs during code analysis)
  if (options.logo) {
    if (process.stdout.isTTY) {
      await playChompBannerAnimation(
        `Initializing Chomp in ${repoName} (${targetPath})`,
        { cycles: 3, frameMs: 200 },
      );
    } else {
      printChompBanner(
        `Frame 1 — Open Mouth Logo (${repoName})`,
        "open",
      );
      printChompBanner(
        `Frame 2 — Chomping Animation Frame (${repoName})`,
        "chomp",
      );
    }
    return;
  }

  printChompBanner(
    isDryRun
      ? `[SANDBOX DRY-RUN] Previewing Chomp setup in ${repoName} (zero file writes)`
      : `Initializing Chomp in ${repoName} (${targetPath})`,
    "open",
  );

  printWelcomeMessage(repoName, isDryRun);

  if (!existsSync(targetPath)) {
    console.error(`  ${ansi.red("✖")} Path does not exist: ${targetPath}`);
    process.exit(1);
  }

  if (!isDryRun) {
    installGlobalChompShims();
  }

  // Paced discovery ticker right beneath the welcome message so the user can view
  // the brand mark while Chomp inspects package.json and monorepo layout
  await runDiscoveryTicker(repoName);

  const isInteractive =
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && !options.yes;
  const printStepDivider = () => {
    console.log(`\n  ${ansi.dim("┄".repeat(66))}\n`);
  };

  // 1. Create .chomp/ and .chomp/plugins/ and update .gitignore (or .git/info/exclude in stealth mode) + Detect Workspace Packages
  const chompDir = resolve(targetPath, ".chomp");
  const chompPluginsDir = resolve(chompDir, "plugins");
  const vaultNotes: string[] = [];
  if (isDryRun) {
    vaultNotes.push(
      `${ansi.cyan("○")} ${ansi.dim("[Sandbox]")} Would create ${ansi.cyan(".chomp/")} (${ansi.cyan(".chomp/plugins/")}) and update ${ansi.cyan(isStealth ? ".git/info/exclude" : ".gitignore")}`,
    );
  } else {
    if (!existsSync(chompDir)) {
      mkdirSync(chompPluginsDir, { recursive: true });
      vaultNotes.push(
        `${ansi.green("✓")} Created ${ansi.cyan(".chomp/")} and ${ansi.cyan(".chomp/plugins/")} local storage`,
      );
    } else {
      mkdirSync(chompPluginsDir, { recursive: true });
      vaultNotes.push(
        `${ansi.green("✓")} Verified ${ansi.cyan(".chomp/")} and ${ansi.cyan(".chomp/plugins/")} local storage`,
      );
    }

    ensureGitExcludeHasChomp(targetPath);

    if (isStealth) {
      vaultNotes.push(
        `${ansi.green("✓")} Hidden ${ansi.cyan(".chomp/")} in ${ansi.cyan(".git/info/exclude")} (stealth mode — zero .gitignore edits)`,
      );
    } else if (ensureGitignoreHasChomp(targetPath)) {
      vaultNotes.push(
        `${ansi.green("✓")} Added ${ansi.cyan(".chomp/")} to ${ansi.cyan(".gitignore")}`,
      );
    }
  }

        const detectedPackages = detectWorkspacePackages(targetPath);
        let dryRunExclusions: string[] | undefined;

        // Render detected workspace configuration in a read-only box table
        printDetectedWorkspaceTable(repoName, detectedPackages, vaultNotes);

        // 2. Optional Package Exclusions Prompt
        if (detectedPackages.length > 1 && isInteractive) {
          printStepDivider();
          const wantCustomizePackages = await confirmPrompt(
            "Exclude any packages?",
            false,
            "Chomp analyzes all detected packages by default.",
          );
          if (wantCustomizePackages) {
            console.log("");
            const includedNames = await multiSelectPrompt<string>(
              "Select packages to analyze",
              "Up/Down to move · Space to toggle · 'a' to toggle all · Enter to confirm",
              detectedPackages.map((p) => ({
                value: p.name,
                label: `${p.name} (${p.relPath})`,
                hint: p.frameworks.length > 0 ? `[${p.frameworks.join(", ")}]` : undefined,
                selected: !p.currentlyExcluded,
              })),
            );
            const includedSet = new Set(includedNames);
            const excluded = detectedPackages
              .filter((p) => !includedSet.has(p.name))
              .map((p) => p.name);
            if (isDryRun) {
              dryRunExclusions = excluded;
              console.log(
                excluded.length > 0
                  ? `  ${ansi.cyan("○")} ${ansi.dim("[Sandbox]")} Would exclude ${excluded.length} package(s) in ${ansi.cyan("chomp.config.json")}: ${excluded.join(", ")}`
                  : `  ${ansi.cyan("○")} ${ansi.dim("[Sandbox]")} All ${detectedPackages.length} packages selected`,
              );
            } else {
              saveExcludeWorkspaces(targetPath, excluded);
              if (excluded.length > 0) {
                console.log(
                  `  ${ansi.green("✓")} Excluded ${excluded.length} package(s) in ${ansi.cyan("chomp.config.json")}: ${excluded.join(", ")}`,
                );
              } else {
                console.log(
                  `  ${ansi.green("✓")} Analyzing all ${detectedPackages.length} packages`,
                );
              }
            }
          }
        }

        // 2b. Scaffold starter `designSystem` plugin config when frontend packages are detected
        const dsScaffold = scaffoldDesignSystemConfig(targetPath, {
          stealth: isStealth,
          dryRun: isDryRun,
          excludeWorkspaces: dryRunExclusions,
        });
        if (dsScaffold.wouldWrite && dsScaffold.configRelPath) {
          console.log(
            `  ${ansi.cyan("○")} ${ansi.dim("[Sandbox]")} Would scaffold ${ansi.cyan("designSystem")} config in ${ansi.cyan(dsScaffold.configRelPath)} (${dsScaffold.frontendPackages.join(", ")})`,
          );
        } else if (dsScaffold.written && dsScaffold.configRelPath) {
          console.log(
            `  ${ansi.green("✓")} Scaffolded ${ansi.cyan("designSystem")} config in ${ansi.cyan(dsScaffold.configRelPath)} (${dsScaffold.frontendPackages.join(", ")})`,
          );
        }

        // 3. Git Hooks (post-commit, post-merge, post-checkout)
        printStepDivider();
        const shouldInstallHooks = isInteractive
          ? await confirmPrompt(
              "Keep Chomp in sync with Git?",
              true,
              "Updates your graph in the background after commits, merges, and branch switches without slowing down Git.",
            )
          : true;

        if (shouldInstallHooks) {
          if (isDryRun) {
            console.log(
              `  ${ansi.cyan("○")} ${ansi.dim("[Sandbox]")} Would add background Git hooks (post-commit, post-merge, post-checkout)`,
            );
          } else {
            const hookRes = installGitHooks(targetPath);
            if (hookRes.files.length > 0) {
              console.log(
                `  ${ansi.green("✓")} Added background Git hooks (${hookRes.files.join(", ")})`,
              );
            } else if (hookRes.mode !== "none") {
              console.log(
                `  ${ansi.green("✓")} Git hooks (${hookRes.mode}) already up to date`,
              );
            }
          }
        }

        // 4. AI Agent & MCP Server Configuration
        printStepDivider();
        const integrations = detectAgentIntegrations(targetPath);
        let selectedAgentIds: string[];

        if (isInteractive) {
          selectedAgentIds = await multiSelectPrompt<string>(
            "Connect AI coding agents",
            "Adds Chomp MCP tools and navigation rules to selected agents · Space to toggle · Enter to confirm",
            integrations.map((agent) => ({
              value: agent.id,
              label: agent.label,
              hint: agent.hint,
              selected: agent.detected,
            })),
          );
        } else {
          selectedAgentIds = integrations
            .filter((a) => a.detected)
            .map((a) => a.id);
        }

        for (const agent of integrations) {
          if (!selectedAgentIds.includes(agent.id)) continue;
          if (isDryRun) {
            console.log(
              `  ${ansi.cyan("○")} ${ansi.dim("[Sandbox]")} Would connect ${ansi.bold(agent.label)} (${ansi.cyan(agent.ruleFile)}${agent.mcpConfigPath ? ` + ${ansi.cyan(agent.mcpConfigPath)}` : ""})`,
            );
            continue;
          }
          if (agent.id === "kiro") {
            const kiroRes = installKiroIntegration(targetPath, {
              stealth: isStealth,
            });
            console.log(
              `  ${ansi.green("✓")} Configured ${ansi.bold("Kiro")} (${ansi.cyan(".kiro/settings/mcp.json")}, ${ansi.cyan(".kiro/steering/chomp-architecture.md")}, ${ansi.cyan(".kiro/hooks/chomp-sync.kiro.hook")}, ${ansi.cyan(".kiro/powers/chomp/")})${isStealth ? ansi.dim(" [hidden in .git/info/exclude]") : ""}`,
            );
            if (!kiroRes.mcpUpdated) {
              console.log(
                `  ${ansi.green("✓")} Preserved existing ${ansi.bold("chomp-server")} entry in ${ansi.cyan(".kiro/settings/mcp.json")}`,
              );
            }
            continue;
          }
          if (isStealth) {
            console.log(
              `  ${ansi.green("✓")} Stealth mode: skipped modifying tracked rule file ${ansi.cyan(agent.ruleFile)}`,
            );
          } else if (injectRuleHarness(targetPath, agent.ruleFile)) {
            console.log(
              `  ${ansi.green("✓")} Added Chomp rules to ${ansi.cyan(agent.ruleFile)}`,
            );
          } else {
            console.log(
              `  ${ansi.green("✓")} Verified Chomp rules in ${ansi.cyan(agent.ruleFile)}`,
            );
          }
          if (agent.mcpConfigPath && (!isStealth || agent.id === "antigravity")) {
            if (upsertMcpServerConfig(agent.mcpConfigPath, targetPath)) {
              console.log(
                `  ${ansi.green("✓")} Connected ${ansi.bold("chomp-server")} MCP in ${ansi.cyan(agent.mcpConfigPath)}`,
              );
            }
          }
        }

        // 5. Run Initial Extraction with Live Chomping Animation & Event Feed
        printStepDivider();
        if (isDryRun) {
          const { commitSha, branchName } = getGitInfo(targetPath);
          const excludeWorkspaces =
            dryRunExclusions ?? loadExcludeWorkspaces(targetPath);
          await runChompExtractionWithAnimation({
            repoName,
            repoPath: targetPath,
            dbPath: `${resolve(targetPath, ".chomp", "graph.db")} (sandbox dry-run)`,
            commitSha,
            branchName,
            excludeWorkspaces,
            isSandbox: true,
            executeExtraction: async () => {
              const t0 = Date.now();
              const graph = analyzeTarget(
                targetPath,
                CORE_EXTRACTOR_VERSION,
                commitSha,
                excludeWorkspaces,
              );
              const durationMs = Date.now() - t0;
              return { graph, durationMs };
            },
          });
        } else {
          await runAnalyze(targetPath);
          const ctx = setActiveChompTarget(targetPath);
          console.log(
            `  ${ansi.green("✓")} Master Tether active: ${ansi.bold(ctx.activeRepoId)} (${ansi.cyan(ctx.activeRepoPath)}) — MCP & Visualizer locked onto this repo`,
          );
        }

        console.log(
          isDryRun
            ? `  ${ansi.green("🎉")} ${ansi.bold("Sandbox preview complete.")} ${ansi.dim("Run 'chomp init' without --sandbox to apply.")}`
            : `  ${ansi.green("🎉")} ${ansi.bold("Chomp is ready!")} ${ansi.dim("Run 'chomp uninstall' anytime to remove Chomp files and hooks.")}`,
        );

        // 6. Offer to Launch the Visualizer
        if (options.ui !== false && isInteractive) {
          printStepDivider();
          const launchNow = await confirmPrompt(
            "Open the Visualizer now?",
            true,
            `Starts the local server at http://localhost:${options.port ?? "5555"} and opens your graph in the browser.`,
          );
          if (launchNow) {
            if (isDryRun) {
              console.log(
                `  ${ansi.cyan("○")} ${ansi.dim("[Sandbox]")} Would open the Visualizer at ${ansi.cyan(`http://localhost:${options.port ?? "5555"}`)}`,
              );
            } else {
              await startUiServer(targetPath, {
                port: options.port ?? "5555",
                open: true,
                watch: true,
              });
            }
          }
        }
}

export function registerInitCommand(program: Command) {
  program
    .command("init [path]")
    .description(
      "Guided 60-second installer: configure packages, git hooks, AI agent MCP harness, and launch the Visualizer.",
    )
    .option("-y, --yes", "Accept recommended defaults without interactive prompts", false)
    .option("--no-ui", "Do not prompt or launch the Chomp Visualizer after setup")
    .option("-p, --port <number>", "Port for the Chomp Visualizer server", "5555")
    .option("--logo", "Preview the Chomp Unicode terminal banner and exit", false)
    .option(
      "--stealth",
      "Keep target repo git-clean: hide .chomp/ in .git/info/exclude and skip modifying .gitignore or tracked rule files",
      false,
    )
    .option(
      "--dry-run, --sandbox",
      "Run the interactive init wizard in sandbox mode without modifying any files or databases",
      false,
    )
    .action(async (inputPath: string | undefined, options: InitWizardOptions) => {
      await runInitWizard(inputPath, options);
    });
}
