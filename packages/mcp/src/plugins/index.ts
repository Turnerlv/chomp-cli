/**
 * packages/mcp/src/plugins/index.ts
 *
 * Zero-plumbing folder auto-discovery entry point for built-in Chomp plugins.
 * Adding a new `<plugin-name>/index.ts` folder in this directory automatically:
 *   1. Registers the plugin in the `ChompPlugin` runtime registry (`listChompPlugins`).
 *   2. Provisions `.chomp/plugins/<plugin-name>/` state & settings (`settings.json`).
 *   3. Exposes its `settingsSchema` in Explorer Settings -> Rules -> PLUGINS.
 *   4. Registers its `mcpTools` on the `@chomp/mcp` server and Settings -> Tools.
 *   5. Wires its `projectGraph`, `isStructuralOverlay`, `PluginPresentation` v1 sections,
 *      Active View lenses (`ctx.setActiveView` & `summary.views`), and `formatCliSummary`.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPluginsInDir, type ChompPlugin } from "../pluginRunner.js";

export const BUILTIN_PLUGINS_DIR = dirname(fileURLToPath(import.meta.url));

export async function discoverBuiltInPlugins(): Promise<ChompPlugin[]> {
  return discoverPluginsInDir(BUILTIN_PLUGINS_DIR);
}

await discoverBuiltInPlugins();
