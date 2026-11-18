#!/usr/bin/env tsx
// packages/cli/src/index.ts
// Chomp CLI entry point.

// Load .env from the package root, anchored to this file's location so it
// works whether invoked via `pnpm --filter @chomp/cli dev` from the repo root
// or directly from inside packages/cli/.
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') }); // packages/cli/.env

import { Command } from "commander";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerMcpCommand } from './commands/mcp.js';
import { registerPushCommand } from "./commands/push.js";
import { registerUiCommand } from "./commands/ui.js";
import { registerExportCommand } from "./commands/export.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerInitCommand } from "./commands/init.js";
import { registerConnectCommand } from "./commands/connect.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerLedgerCommand } from "./commands/ledger.js";
import { registerPluginCommand } from "./commands/plugin.js";

export type {
  LayoutData,
  WorkingNode,
  SystemHealthSummary,
  PackageHealthStats,
} from "./visualizer/types.js";

const program = new Command();

program
  .name("chomp")
  .description("Chomp CLI - Software Representation Engine");

registerAnalyzeCommand(program);
registerHealthCommand(program);
registerMcpCommand(program);
registerPushCommand(program);
registerUiCommand(program);
registerExportCommand(program);
registerDiffCommand(program);
registerInitCommand(program);
registerConnectCommand(program);
registerUninstallCommand(program);
registerAuditCommand(program);
registerLedgerCommand(program);
registerPluginCommand(program);

program.parse(process.argv);
