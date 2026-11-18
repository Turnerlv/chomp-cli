/**
 * packages/mcp/src/designSystem/config.ts
 *
 * Configuration for the `design-system` plugin. Nothing in the plugin core may assume a
 * particular repo's naming (`--surface-*`, `sg-*`, `<Drawer>` …). Repo-specific knowledge lives
 * here, supplied via the `designSystem` key of `chomp.config.json` at the repo root, and is
 * otherwise *derived* from the code ("extract" mode).
 *
 * Modes
 *   - `extract` (default when no system is declared): tiers, theme contexts, atoms and
 *     conventions are derived from the code itself.
 *   - `adhere`: a declared system (`tokens.sources` and/or `atoms.definitions`) is the single
 *     source of truth; anything outside it is reported as drift.
 *   - `auto`: `adhere` if the config declares a system, else `extract`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type DesignSystemMode = "auto" | "extract" | "adhere";
export type ResolvedDesignSystemMode = "extract" | "adhere";

export interface AtomMatcher {
  /** Lowercase DOM tag(s), e.g. `"button"` or `["dialog", "aside"]`. */
  tag?: string | string[];
  /** ARIA role, e.g. `"switch"`. */
  role?: string;
  /** Regex source tested against the element's `className` string. */
  classPattern?: string;
  /** Required static attribute values, e.g. `{ "type": "checkbox" }`. */
  attrs?: Record<string, string>;
}

export interface AtomDefinition {
  /** Canonical shared component name, e.g. `Button`. */
  name: string;
  description?: string;
  /** Any matcher hitting means a raw DOM element is an un-shared instance of this atom. */
  matchers: AtomMatcher[];
  /** Existing shared component names (case-insensitive) that satisfy this atom. Default: `[name, "Shared"+name]`. */
  sharedComponentNames?: string[];
}

export interface PropFamily {
  semanticRole: string;
  propNames: string[];
  canonicalRecommendation?: string;
}

export interface ContrastPairConfig {
  fg: string;
  bg: string;
  label?: string;
  minRatio?: number;
}

export interface DesignSystemConfig {
  mode: DesignSystemMode;
  scope: {
    /** `"auto"` detects frontend packages from `package.json` dependencies; or explicit package names / repo-relative path prefixes (`*` globs allowed). */
    packages: "auto" | string[];
    /** Package names / path prefixes to always exclude. */
    exclude: string[];
    /** Dependency names that mark a package as frontend when `packages` is `"auto"`. */
    frontendDependencies: string[];
    /** Regex sources for repo-relative file paths to skip (tests, stories, mocks…). */
    excludeFiles: string[];
  };
  tokens: {
    /** Adhere mode: CSS files (repo-relative path or glob) that *define* the system. Tokens declared elsewhere are drift. */
    sources: string[];
    /** Explicit tier regexes (tested against the token name) that override derivation. */
    tiers: { primitive: string[]; semantic: string[]; component: string[] };
    /** Token-name prefixes owned by third parties; never reported as undefined (`--tw-`, `--radix-`). */
    externalPrefixes: string[];
  };
  themes: {
    /** Regex sources tested against `<at-rule> <selector>`. */
    dark: string[];
    light: string[];
  };
  contrast: {
    minRatio: number;
    /** Explicit fg/bg token pairs always evaluated. */
    pairs: ContrastPairConfig[];
    /** Evaluate `color: var(--x)` + `background: var(--y)` pairs found in the same CSS rule. */
    discoverFromRules: boolean;
    /** Evaluate `--x-foreground` on `--x` and `--foreground` on `--background` conventions. */
    discoverFromNaming: boolean;
    /** Token used as the opaque base when compositing translucent backgrounds (default: probes common names). */
    canvasToken?: string;
  };
  styling: {
    /** Extra class-name prefixes that always count as stylesheet classes (classes found in the repo's CSS are detected automatically). */
    cssClassPrefixes: string[];
    /** Canvas (PixiJS) provenance conventions. Empty by default: no repo's recorder API is assumed. */
    canvas: {
      slotRecorderFactories: string[];
      cssValueHelpers: string[];
      tokenReaderHelpers: string[];
    };
    tailwind: {
      /** `allow`: Tailwind's default palette (`bg-red-500`) is not drift. `flag`: always drift. */
      defaultPalette: "allow" | "flag";
      /** Palette names always treated as raw primitives (in addition to palettes derived from the repo's own primitive tokens). */
      rawPalettes: string[];
      /** Palette names never treated as raw primitives. */
      allowedPalettes: string[];
    };
  };
  atoms: {
    /** `defaults`: built-in generic HTML-semantic catalog; `extend`: defaults + `definitions`; `replace`: only `definitions`. */
    catalog: "defaults" | "extend" | "replace";
    definitions: AtomDefinition[];
    /** In extract mode, un-shared raw instances are only reported when a shared component exists OR this many instances are found. */
    minUnsharedInstances: number;
  };
  concepts: {
    /** Name-suffix abbreviations normalised before grouping (`Btn` → `Button`). */
    abbreviations: Record<string, string>;
    minGroupSize: number;
    /** Min Jaccard similarity of (props ∪ DOM tags ∪ tokens) for components to be called parallel twins. */
    minSimilarity: number;
  };
  propFamilies: PropFamily[];
  clustering: {
    /** Max OKLab distance for two literal colors to be one cluster. */
    colorThreshold: number;
    /** Max OKLab distance for a cluster to be matched to an existing token. */
    tokenMatchThreshold: number;
    /** Max px distance (or 4%, whichever is larger) for two lengths to be one cluster. */
    lengthTolerancePx: number;
    minOccurrences: number;
    maxClusters: number;
  };
  composability: {
    /** Atoms must not import these (modules bind them to a data layer / router). */
    forbiddenImports: string[];
    flagRootMargin: boolean;
    flagFixedWidth: boolean;
  };
  invariants: {
    /** Regex source: JSX props matching this must not receive raw color literals. */
    colorPropPattern: string;
  };
  baseline: {
    /** Repo-relative path of the diff baseline snapshot. */
    path: string;
  };
}

export const DEFAULT_FRONTEND_DEPENDENCIES: readonly string[] = [
  "react",
  "react-dom",
  "preact",
  "next",
  "vue",
  "nuxt",
  "svelte",
  "@sveltejs/kit",
  "solid-js",
  "astro",
  "@remix-run/react",
  "react-router",
  "react-router-dom",
  "@angular/core",
  "lit",
  "tailwindcss",
  "styled-components",
  "@emotion/react",
  "@emotion/styled",
  "@stitches/react",
  "@vanilla-extract/css",
  "pixi.js",
];

/** Generic, HTML-semantic atom catalog. Order matters: first matching definition wins per element. */
export const DEFAULT_ATOM_CATALOG: readonly AtomDefinition[] = [
  {
    name: "Switch",
    description: "Accessible boolean toggle (`role=\"switch\"`).",
    matchers: [{ role: "switch" }],
  },
  {
    name: "Checkbox",
    description: "Checkbox input (`<input type=\"checkbox\">`).",
    matchers: [{ tag: "input", attrs: { type: "checkbox" } }],
  },
  {
    name: "Tooltip",
    description: "Hover/focus hint (`role=\"tooltip\"`).",
    matchers: [{ role: "tooltip" }],
  },
  {
    name: "Dialog",
    description: "Modal / drawer / sheet surface (`<dialog>`, `role=\"dialog\"`).",
    matchers: [{ tag: "dialog" }, { role: "dialog" }, { role: "alertdialog" }],
    sharedComponentNames: ["Dialog", "Modal", "Drawer", "Sheet", "SharedDialog"],
  },
  {
    name: "Alert",
    description: "Contextual message (`role=\"alert\"` / `role=\"status\"`).",
    matchers: [{ role: "alert" }, { role: "status" }],
    sharedComponentNames: ["Alert", "Banner", "Callout", "Notice", "SharedAlert"],
  },
  {
    name: "Select",
    matchers: [{ tag: "select" }],
  },
  {
    name: "Textarea",
    matchers: [{ tag: "textarea" }],
  },
  {
    name: "Input",
    matchers: [{ tag: "input" }],
    sharedComponentNames: ["Input", "TextField", "TextInput", "SharedInput"],
  },
  {
    name: "DescriptionList",
    description: "Key/value metadata grid (`<dl>`).",
    matchers: [{ tag: "dl" }],
    sharedComponentNames: ["DescriptionList", "KeyValueList", "KeyValue", "DefinitionList"],
  },
  {
    name: "Button",
    description: "Interactive action (`<button>`).",
    matchers: [{ tag: "button" }],
    sharedComponentNames: ["Button", "Btn", "SharedButton"],
  },
];

export const DEFAULT_DARK_THEME_PATTERNS: readonly string[] = [
  "\\[data-theme\\s*=\\s*[\"']?dark[\"']?\\]",
  "\\[data-mode\\s*=\\s*[\"']?dark[\"']?\\]",
  "\\[data-color-scheme\\s*=\\s*[\"']?dark[\"']?\\]",
  "(?:^|[\\s,>+~(])\\.dark\\b",
  "\\.theme-dark\\b",
  "prefers-color-scheme\\s*:\\s*dark",
];

export const DEFAULT_LIGHT_THEME_PATTERNS: readonly string[] = [
  "\\[data-theme\\s*=\\s*[\"']?light[\"']?\\]",
  "\\[data-mode\\s*=\\s*[\"']?light[\"']?\\]",
  "\\[data-color-scheme\\s*=\\s*[\"']?light[\"']?\\]",
  "(?:^|[\\s,>+~(])\\.light\\b",
  "\\.theme-light\\b",
  "prefers-color-scheme\\s*:\\s*light",
];

export const DEFAULT_PROP_FAMILIES: readonly PropFamily[] = [
  {
    semanticRole: "Dismiss / Close Callback",
    propNames: ["onClose", "onDismiss", "onCancel", "handleClose"],
    canonicalRecommendation: "Standardize dismissal callbacks on one name (e.g. `onClose`).",
  },
  {
    semanticRole: "Overlay Open State",
    propNames: ["open", "isOpen"],
    canonicalRecommendation: "Standardize overlay visibility on one boolean prop (e.g. `open`).",
  },
  {
    semanticRole: "Checked State",
    propNames: ["checked", "isChecked"],
    canonicalRecommendation: "Standardize checked state on one boolean prop (e.g. `checked`).",
  },
  {
    semanticRole: "Active / Selected State",
    propNames: ["active", "isActive", "selected", "isSelected"],
    canonicalRecommendation: "Standardize active/selected state on one boolean prop.",
  },
  {
    semanticRole: "Disabled State",
    propNames: ["disabled", "isDisabled"],
    canonicalRecommendation: "Standardize disabled state on one boolean prop (e.g. `disabled`).",
  },
];

export const DEFAULT_DESIGN_SYSTEM_CONFIG: DesignSystemConfig = {
  mode: "auto",
  scope: {
    packages: "auto",
    exclude: [],
    frontendDependencies: [...DEFAULT_FRONTEND_DEPENDENCIES],
    excludeFiles: [
      "\\.(?:test|spec|stories|story)\\.[a-z]+$",
      "(?:^|/)__(?:tests|mocks|snapshots)__/",
    ],
  },
  tokens: {
    sources: [],
    tiers: { primitive: [], semantic: [], component: [] },
    externalPrefixes: [
      "--tw-",
      "--radix-",
      "--rsbuild-",
      "--next-",
      "--mui-",
      "--chakra-",
      "--mantine-",
      "--ant-",
      "--shiki-",
    ],
  },
  themes: {
    dark: [...DEFAULT_DARK_THEME_PATTERNS],
    light: [...DEFAULT_LIGHT_THEME_PATTERNS],
  },
  contrast: {
    minRatio: 4.5,
    pairs: [],
    discoverFromRules: true,
    discoverFromNaming: true,
  },
  styling: {
    cssClassPrefixes: [],
    canvas: { slotRecorderFactories: [], cssValueHelpers: [], tokenReaderHelpers: [] },
    tailwind: { defaultPalette: "allow", rawPalettes: [], allowedPalettes: [] },
  },
  atoms: { catalog: "defaults", definitions: [], minUnsharedInstances: 3 },
  concepts: {
    abbreviations: {
      Btn: "Button",
      Dlg: "Dialog",
      Img: "Image",
      Nav: "Navigation",
      Pnl: "Panel",
      Tbl: "Table",
    },
    minGroupSize: 2,
    minSimilarity: 0.34,
  },
  propFamilies: [...DEFAULT_PROP_FAMILIES],
  clustering: {
    colorThreshold: 0.035,
    tokenMatchThreshold: 0.045,
    lengthTolerancePx: 1,
    minOccurrences: 2,
    maxClusters: 40,
  },
  composability: {
    forbiddenImports: [
      "next/router",
      "next/navigation",
      "react-router",
      "react-router-dom",
      "@tanstack/react-query",
      "swr",
      "redux",
      "react-redux",
      "zustand",
      "axios",
    ],
    flagRootMargin: true,
    flagFixedWidth: true,
  },
  invariants: {
    colorPropPattern: "(?:^|[a-z])(?:[Cc]olor|[Cc]olour|[Bb]g|[Bb]ackground|[Ff]ill|[Ss]troke|[Tt]int)$",
  },
  baseline: { path: ".chomp/plugins/design-system/baseline.json" },
};

export interface ResolvedDesignSystemConfig {
  config: DesignSystemConfig;
  /** Absolute path of the config file that supplied overrides, if any. */
  configPath: string | null;
  /** True when the user declared at least one system source / atom definition. */
  declaresSystem: boolean;
  mode: ResolvedDesignSystemMode;
  modeReason: string;
  /** Non-fatal problems found in the user config (invalid regexes, bad types). */
  warnings: string[];
}

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeDeep<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T)) as T;
  }
  const out: PlainObject = { ...(base as PlainObject) };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const b = (base as PlainObject)[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? mergeDeep(b, v) : v;
  }
  return out as T;
}

export function validateRegexSources(
  label: string,
  sources: readonly string[],
  warnings: string[]
): string[] {
  const valid: string[] = [];
  for (const s of sources) {
    try {
      new RegExp(s);
      valid.push(s);
    } catch {
      warnings.push(`designSystem config: ignoring invalid regex in ${label}: ${s}`);
    }
  }
  return valid;
}

export function compileRegexes(sources: readonly string[], flags = "i"): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources) {
    try {
      out.push(new RegExp(s, flags));
    } catch {
      /* invalid sources are reported by validateRegexSources */
    }
  }
  return out;
}

/** Converts a repo-relative glob (`*`, `**`) or plain prefix to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  const clean = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const escaped = clean
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

export function resolveDesignSystemConfig(
  repoPath: string,
  overrides?: Partial<DesignSystemConfig> | Record<string, unknown>
): ResolvedDesignSystemConfig {
  const warnings: string[] = [];
  let configPath: string | null = null;
  let userConfig: unknown;

  const candidate = resolve(repoPath, "chomp.config.json");
  if (existsSync(candidate)) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (isPlainObject(parsed) && isPlainObject(parsed.designSystem)) {
        userConfig = parsed.designSystem;
        configPath = candidate;
      }
    } catch (err) {
      warnings.push(
        `designSystem config: could not parse chomp.config.json (${(err as Error).message})`
      );
    }
  }
  if (!userConfig) {
    const stealthCandidate = resolve(
      repoPath,
      ".chomp",
      "plugins",
      "design-system",
      "config.json"
    );
    if (existsSync(stealthCandidate)) {
      try {
        const parsed = JSON.parse(readFileSync(stealthCandidate, "utf8"));
        if (isPlainObject(parsed)) {
          userConfig = isPlainObject(parsed.designSystem) ? parsed.designSystem : parsed;
          configPath = stealthCandidate;
        }
      } catch (err) {
        warnings.push(
          `designSystem config: could not parse .chomp/plugins/design-system/config.json (${(err as Error).message})`
        );
      }
    }
  }

  let config = mergeDeep(DEFAULT_DESIGN_SYSTEM_CONFIG, userConfig);
  if (overrides) config = mergeDeep(config, overrides);

  config.tokens.tiers = {
    primitive: validateRegexSources("tokens.tiers.primitive", config.tokens.tiers.primitive, warnings),
    semantic: validateRegexSources("tokens.tiers.semantic", config.tokens.tiers.semantic, warnings),
    component: validateRegexSources("tokens.tiers.component", config.tokens.tiers.component, warnings),
  };
  config.themes = {
    dark: validateRegexSources("themes.dark", config.themes.dark, warnings),
    light: validateRegexSources("themes.light", config.themes.light, warnings),
  };
  config.scope.excludeFiles = validateRegexSources(
    "scope.excludeFiles",
    config.scope.excludeFiles,
    warnings
  );
  for (const def of config.atoms.definitions) {
    for (const m of def.matchers ?? []) {
      if (m.classPattern) {
        validateRegexSources(`atoms.definitions[${def.name}].classPattern`, [m.classPattern], warnings);
      }
    }
  }

  const declaresSystem =
    config.tokens.sources.length > 0 || config.atoms.definitions.length > 0;
  let mode: ResolvedDesignSystemMode;
  let modeReason: string;
  if (config.mode === "adhere") {
    mode = "adhere";
    modeReason = declaresSystem
      ? "config.mode = adhere"
      : "config.mode = adhere but no tokens.sources / atoms.definitions declared; nothing to adhere to, so token/atom drift checks are limited";
  } else if (config.mode === "extract") {
    mode = "extract";
    modeReason = "config.mode = extract";
  } else if (declaresSystem) {
    mode = "adhere";
    modeReason = "auto: a system is declared in chomp.config.json (tokens.sources / atoms.definitions)";
  } else {
    mode = "extract";
    modeReason = "auto: no system declared; deriving the system from the code";
  }

  return { config, configPath, declaresSystem, mode, modeReason, warnings };
}

// ---------------------------------------------------------------------------
// Frontend package scoping
// ---------------------------------------------------------------------------

export interface DetectedPackageScope {
  /** Repo-relative POSIX directory ("." for the root). */
  dir: string;
  name?: string;
  frontend: boolean;
  /** Why the package was included / excluded. */
  reason: string;
}

export interface FrontendScope {
  packages: DetectedPackageScope[];
  includeFile: (relPath: string) => boolean;
  /** Repo-relative dirs of included packages. */
  includedDirs: string[];
}

interface PackageJsonLike {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function detectFrontendScope(
  files: string[],
  readFile: (relPath: string) => string | null,
  config: DesignSystemConfig
): FrontendScope {
  const pkgCache = new Map<string, PackageJsonLike | null>();
  const readPkg = (dir: string): PackageJsonLike | null => {
    if (pkgCache.has(dir)) return pkgCache.get(dir) ?? null;
    const raw = readFile(dir === "." ? "package.json" : `${dir}/package.json`);
    let parsed: PackageJsonLike | null = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as PackageJsonLike;
      } catch {
        parsed = null;
      }
    }
    pkgCache.set(dir, parsed);
    return parsed;
  };

  const owningDirCache = new Map<string, string>();
  const owningDir = (relPath: string): string => {
    const startDir = dirname(relPath).replace(/\\/g, "/");
    if (owningDirCache.has(startDir)) return owningDirCache.get(startDir)!;
    let dir = startDir === "" ? "." : startDir;
    const visited: string[] = [];
    let found = ".";
    for (;;) {
      visited.push(dir);
      if (readPkg(dir)) {
        found = dir;
        break;
      }
      if (dir === ".") break;
      const parent = dirname(dir).replace(/\\/g, "/");
      dir = parent === "" ? "." : parent;
    }
    for (const v of visited) owningDirCache.set(v, found);
    return found;
  };

  const explicit = config.scope.packages === "auto" ? null : config.scope.packages;
  const explicitRes = explicit?.map((p) => ({ raw: p, re: globToRegExp(p) })) ?? null;
  const excludeRes = config.scope.exclude.map((p) => ({ raw: p, re: globToRegExp(p) }));
  const frontendDeps = new Set(config.scope.frontendDependencies);
  const uiExt = /\.(?:tsx|jsx|vue|svelte|astro|mdx|css|scss|sass|less)$/i;

  const dirsWithFiles = new Map<string, string[]>();
  for (const f of files) {
    const d = owningDir(f);
    let list = dirsWithFiles.get(d);
    if (!list) {
      list = [];
      dirsWithFiles.set(d, list);
    }
    list.push(f);
  }

  const packages: DetectedPackageScope[] = [];
  for (const [dir, dirFiles] of dirsWithFiles.entries()) {
    const pkg = readPkg(dir);
    const name = pkg?.name;
    const matchesRef = (re: RegExp, raw: string): boolean =>
      re.test(dir) || (name !== undefined && (name === raw || re.test(name)));

    const excluded = excludeRes.find((e) => matchesRef(e.re, e.raw));
    if (excluded) {
      packages.push({ dir, name, frontend: false, reason: `excluded by scope.exclude (${excluded.raw})` });
      continue;
    }
    if (explicitRes) {
      const hit = explicitRes.find((e) => matchesRef(e.re, e.raw));
      packages.push(
        hit
          ? { dir, name, frontend: true, reason: `listed in scope.packages (${hit.raw})` }
          : { dir, name, frontend: false, reason: "not listed in scope.packages" }
      );
      continue;
    }

    const deps = {
      ...(pkg?.dependencies ?? {}),
      ...(pkg?.devDependencies ?? {}),
      ...(pkg?.peerDependencies ?? {}),
    };
    const matchedDep = Object.keys(deps).find((d) => frontendDeps.has(d));
    if (matchedDep) {
      packages.push({ dir, name, frontend: true, reason: `depends on ${matchedDep}` });
    } else if (!pkg && dirFiles.some((f) => uiExt.test(f))) {
      packages.push({
        dir,
        name,
        frontend: true,
        reason: "no package.json; contains UI source files (tsx/jsx/css/…)",
      });
    } else {
      packages.push({
        dir,
        name,
        frontend: false,
        reason: pkg
          ? "no UI framework dependency (backend / library package)"
          : "no package.json and no UI source files",
      });
    }
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));

  const includedSet = new Set(packages.filter((p) => p.frontend).map((p) => p.dir));
  return {
    packages,
    includedDirs: [...includedSet].sort(),
    includeFile: (relPath: string) => includedSet.has(owningDir(relPath)),
  };
}
