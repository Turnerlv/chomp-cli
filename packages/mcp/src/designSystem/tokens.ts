/**
 * packages/mcp/src/designSystem/tokens.ts
 *
 * Derives token tiers (primitive → semantic → component) from the *reference graph* of the
 * repo's own CSS custom properties instead of from naming conventions:
 *
 *   - a literal (non-aliased) token  → primitive   (or semantic when it is re-declared per theme)
 *   - an alias of primitives only    → semantic
 *   - an alias involving a semantic/component token, or a token declared in a scoped
 *     selector (`.card { --card-bg }`) → component
 *
 * Explicit `designSystem.tokens.tiers` regexes always win. `@theme` bridge tokens stay
 * "semantic" (they are the Tailwind v4 theme surface).
 */

import { compileRegexes, type DesignSystemConfig } from "./config.js";
import type { CssTokenDeclaration, TokenTier } from "../designSystemPlugin.js";

export type TokenTierSource = "config" | "derived" | "scoped" | "theme-bridge";

export interface DerivedTier {
  tier: TokenTier;
  source: TokenTierSource;
}

const SCALE_NAME_RE = /^(?:--|\$|@)(?:[a-z][a-z0-9]*-)*[a-z][a-z0-9]*-\d{1,4}$/;

export function isScaleStepTokenName(name: string): boolean {
  return SCALE_NAME_RE.test(name.toLowerCase());
}

export function deriveTokenTiers(
  decls: CssTokenDeclaration[],
  tiers: DesignSystemConfig["tokens"]["tiers"]
): Map<string, DerivedTier> {
  const primRes = compileRegexes(tiers.primitive);
  const semRes = compileRegexes(tiers.semantic);
  const compRes = compileRegexes(tiers.component);

  const byName = new Map<string, CssTokenDeclaration[]>();
  for (const d of decls) {
    let list = byName.get(d.name);
    if (!list) {
      list = [];
      byName.set(d.name, list);
    }
    list.push(d);
  }

  const memo = new Map<string, DerivedTier>();
  const visiting = new Set<string>();

  const resolve = (name: string): DerivedTier => {
    const cached = memo.get(name);
    if (cached) return cached;
    const list = byName.get(name) ?? [];

    let out: DerivedTier;
    if (compRes.some((re) => re.test(name))) out = { tier: "component", source: "config" };
    else if (semRes.some((re) => re.test(name))) out = { tier: "semantic", source: "config" };
    else if (primRes.some((re) => re.test(name))) out = { tier: "primitive", source: "config" };
    else if (list.length > 0 && list.every((d) => d.themeContext === "theme-bridge")) {
      out = { tier: "semantic", source: "theme-bridge" };
    } else {
      const globals = list.filter((d) => d.scope !== "scoped");
      if (globals.length === 0) {
        out = { tier: "component", source: "scoped" };
      } else if (visiting.has(name)) {
        out = { tier: "semantic", source: "derived" };
      } else {
        visiting.add(name);
        const refs = new Set<string>();
        for (const d of globals) for (const r of d.referencedVars) refs.add(r);
        refs.delete(name);
        const definedRefs = [...refs].filter((r) => byName.has(r));

        if (refs.size === 0) {
          const themed = globals.some(
            (d) => d.themeContext === "dark" || d.themeContext === "light"
          );
          out = { tier: themed ? "semantic" : "primitive", source: "derived" };
        } else {
          const refTiers = definedRefs.map((r) => resolve(r).tier);
          const involvesHigher = refTiers.some((t) => t === "semantic" || t === "component");
          out = { tier: involvesHigher ? "component" : "semantic", source: "derived" };
        }
        visiting.delete(name);
      }
    }
    memo.set(name, out);
    return out;
  };

  const result = new Map<string, DerivedTier>();
  for (const name of byName.keys()) result.set(name, resolve(name));
  return result;
}
