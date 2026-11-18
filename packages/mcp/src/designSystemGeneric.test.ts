/**
 * Proves the design-system plugin is repo-agnostic: it audits a committed shadcn/Tailwind-style fixture
 * (`fixtures/design-system/tailwind-drift`) that shares no naming with Chomp, with ground truth in
 * that fixture's `expected.json`. Nothing here may depend on Chomp token / class / component names.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeTarget, readPresentationFromPayload, sanitizePluginPresentation } from "@chomp/core";
import {
  auditDesignSystem,
  createDesignSystemPlugin,
  diffDesignSystem,
  parseCssColorString,
  scanTsxOrTsFile,
  snapshotDesignSystemBaseline,
  type DesignSystemAnalysisReport,
} from "./designSystemPlugin.js";
import { checkWorkingTreeClean, diffFindings, findingKey, type FindingRecord } from "./designSystem/baseline.js";
import { oklabDistance, toOklab } from "./designSystem/color.js";
import { detectFrontendScope, DEFAULT_DESIGN_SYSTEM_CONFIG } from "./designSystem/config.js";
import { clusterLiteralValues, type LiteralValueOccurrence } from "./designSystem/valueClusters.js";
import { enforcePresentationContract, runChompPlugin } from "./pluginRunner.js";
import { designSystemPluginModule } from "./plugins/design-system/index.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const FIXTURE = resolve(REPO_ROOT, "fixtures/design-system/tailwind-drift");
const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8"));

const SCRATCH = mkdtempSync(join(tmpdir(), "chomp-ds-generic-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const graph = analyzeTarget(FIXTURE);
const CLEAN = () => ({ clean: true as const, dirtyFiles: [] as string[] });
const DIRTY = () => ({ clean: false as const, dirtyFiles: ["apps/web/src/components/Legacy.tsx", "apps/web/src/app/globals.css"] });

async function runReport(
  configOverrides?: Parameters<typeof createDesignSystemPlugin>[0]
): Promise<DesignSystemAnalysisReport> {
  const res = await runChompPlugin(createDesignSystemPlugin(configOverrides), {
    repoPath: FIXTURE,
    repoName: "fixture",
    graph,
    persist: false,
  });
  return res.summary.report as DesignSystemAnalysisReport;
}

describe("Design System plugin is repo-agnostic (shadcn/Tailwind fixture)", () => {
  it("audits frontend packages only, in extract mode, with no config file", async () => {
    const report = await runReport();
    assert.equal(report.system.mode, expected.scope.mode);
    assert.equal(report.system.configPath, null);
    const front = report.system.packages.filter((p) => p.frontend).map((p) => p.dir);
    assert.deepEqual(front, expected.scope.frontendPackages);
    for (const excluded of expected.scope.excludedPackages) {
      const pkg = report.system.packages.find((p) => p.dir === excluded);
      assert.ok(pkg && !pkg.frontend, `${excluded} must be out of scope`);
    }

    // Nothing from the backend package leaks into any finding, literal pool or evidence
    const json = JSON.stringify(report);
    assert.ok(
      !json.includes(expected.notFlagged.backendLiteral),
      "backend files must never appear in the report",
    );
  });

  it("derives theme contexts and token tiers from the code, honoring @property / fallbacks / external prefixes", async () => {
    const report = await runReport();
    assert.deepEqual(report.system.themesObserved, expected.themes.observed);

    for (const t of expected.tokens.tiers.primitive) assert.ok(report.tokenCatalog.primitive.includes(t), `${t} primitive`);
    for (const t of expected.tokens.tiers.semantic) assert.ok(report.tokenCatalog.semantic.includes(t), `${t} semantic`);
    for (const t of expected.tokens.themeBridge) assert.ok(report.tokenCatalog.themeBridge.includes(t), `${t} @theme`);
    for (const t of expected.tokens.definedViaAtProperty) {
      const defined = [...report.tokenCatalog.primitive, ...report.tokenCatalog.semantic, ...report.tokenCatalog.component];
      assert.ok(defined.includes(t), `${t} declared via @property is a defined token`);
    }

    const undef = report.diagnostics.undefinedTokens.map((u) => u.name).sort();
    assert.deepEqual(undef, [...expected.tokens.undefined].sort());
    for (const name of Object.keys(expected.tokens.notUndefined)) {
      assert.ok(!undef.includes(name), `${name} must not be reported as undefined`);
    }
  });

  it("evaluates contrast for .dark + :root themes with HSL/oklch tokens and reports unresolved pairs explicitly", async () => {
    const report = await runReport();
    const audited = report.diagnostics.contrastAudits.map((c) => c.pairId).sort();
    assert.deepEqual(audited, [...expected.contrast.audited].sort());
    assert.deepEqual(
      report.diagnostics.contrastFailures.map((c) => c.pairId),
      expected.contrast.failing,
    );

    const unresolved = report.coverage.contrastUnresolved.filter(
      (u) => u.pairId === expected.contrast.unresolved.pairId,
    );
    assert.deepEqual(unresolved.map((u) => u.theme).sort(), expected.contrast.unresolved.themes);
    assert.ok(unresolved.every((u) => u.reason === expected.contrast.unresolved.reason));
    assert.ok(
      report.coverage.notes.some((n) => n.includes("could not be evaluated")),
      "absence of failures must not be mistaken for passing",
    );
  });

  it("measures shared-atom adoption and merges SubmitButton / NavButton / ActionBtn into one proposed Button family", async () => {
    const report = await runReport();
    const button = report.atomicConsolidation.find((a) => a.atomName === "Button");
    assert.ok(button, "Expected Button consolidation entry");
    assert.equal(button.existingSharedComponent?.filePath, expected.atoms.sharedButton);
    assert.equal(button.instanceCount, expected.atoms.rawButtonInstances);
    assert.equal(button.adopterCount, expected.atoms.adopters);
    assert.equal(button.adoptionRate, expected.atoms.adoptionRate);

    const twin = report.alignmentAudit.parallelTwins.find((t) => t.concept === expected.parallelTwins.concept);
    assert.ok(twin, "Expected a Button family twin group");
    assert.deepEqual(twin.components.map((c) => c.label).sort(), expected.parallelTwins.components);
    assert.ok(twin.similarity >= DEFAULT_DESIGN_SYSTEM_CONFIG.concepts.minSimilarity);
    assert.ok(twin.proposedProps.some((p) => p.name === "label" && p.usedBy === 3));
    assert.deepEqual(twin.observedVariants, expected.parallelTwins.observedVariants);
    assert.match(twin.recommendation, /existing <Button>/);
  });

  it("detects compositional clones (Card + Thumbnail + TextLink) that raw-DOM fingerprints could never see", async () => {
    const report = await runReport();
    const want = expected.structuralClones[0];
    const group = report.dryAudit.structuralJsxClones.find(
      (g) => g.suggestedComponentName === want.suggestedComponentName,
    );
    assert.ok(group, "Expected the CardThumbnailTextLink composition to be detected");
    assert.equal(group.compositional, want.compositional);
    assert.equal(group.occurrenceCount, want.occurrenceCount);
    assert.equal(group.distinctFileCount, want.distinctFileCount);
  });

  it("clusters hardcoded values into candidate tokens and matches them to existing tokens", async () => {
    const report = await runReport();
    const grey = report.derivedTokens.find(
      (d) => d.kind === "color" && expected.derivedTokens[0].members.every((m: string) => d.members.some((x) => x.value.toLowerCase() === m)),
    );
    assert.ok(grey, "Expected #333333 / #323232 / #343434 to collapse into one cluster");
    assert.ok(grey.occurrenceCount >= 6);
    assert.ok(grey.surfaces.includes("css-rule") && grey.surfaces.includes("tailwind-arbitrary"));
    assert.equal(grey.existingTokenMatch, undefined, "no token covers that grey");
    assert.match(grey.suggestedTokenName ?? "", /^--color-neutral-\d+$/);

    const white = report.derivedTokens.find((d) => d.kind === "color" && d.representative === "#ffffff");
    assert.equal(white?.existingTokenMatch?.name, expected.derivedTokens[1].existingTokenMatch);
  });

  it("flags prop-literal invariants and atom composability issues, and reports unsupported files", async () => {
    const report = await runReport();
    const inv = report.alignmentAudit.invariantViolations;
    assert.equal(inv.length, 1);
    assert.equal(inv[0]!.childComponent, expected.invariantViolations[0].child);
    assert.equal(inv[0]!.prop, expected.invariantViolations[0].prop);
    assert.equal(inv[0]!.value, expected.invariantViolations[0].value);

    const kinds = report.alignmentAudit.composabilityIssues
      .filter((c) => c.component === expected.composability[0].component)
      .map((c) => c.kind)
      .sort();
    assert.deepEqual(kinds, [...expected.composability[0].kinds].sort());

    assert.deepEqual(
      report.coverage.unsupportedFiles.map((u) => ({ extension: u.extension, count: u.count })),
      expected.coverage.unsupportedFiles,
    );
  });

  it("does not treat Tailwind's default palette as drift unless configured to", async () => {
    const lenient = await runReport();
    const skipsLenient = lenient.components.flatMap((c) => c.primitiveScaleSkips.map((s) => s.tokenOrClass));
    for (const cls of expected.notFlagged.tailwindDefaultPalette) {
      assert.ok(!skipsLenient.includes(cls), `${cls} must not be flagged by default`);
    }

    const strict = await runReport({ styling: { tailwind: { defaultPalette: "flag", rawPalettes: [], allowedPalettes: [] } } } as never);
    const skipsStrict = strict.components.flatMap((c) => c.primitiveScaleSkips.map((s) => s.tokenOrClass));
    for (const cls of expected.notFlagged.tailwindDefaultPalette) {
      assert.ok(skipsStrict.some((s) => s.endsWith(cls)), `${cls} flagged when defaultPalette = flag`);
    }
  });

  it("scoping is configuration: explicit packages, exclusions, and 'no frontend detected' are all honest", async () => {
    const backendOnly = await runReport({ scope: { packages: ["@fixture/api"] } } as never);
    assert.deepEqual(
      backendOnly.system.packages.filter((p) => p.frontend).map((p) => p.dir),
      ["packages/api"],
    );

    const none = await runReport({ scope: { packages: [], exclude: [] } } as never);
    assert.equal(none.summary.frontendPackageCount, 0);
    assert.equal(none.summary.componentsProfiled, 0);
    assert.ok(none.coverage.notes.some((n) => n.includes("No frontend packages")));

    const excluded = await runReport({ scope: { exclude: ["@fixture/web"] } } as never);
    assert.equal(excluded.summary.frontendPackageCount, 0);
  });

  it("adhere mode treats declared token sources as the system and reports tokens declared outside it", async () => {
    const report = await runReport({
      mode: "adhere",
      tokens: { sources: ["apps/web/src/styles/**"] },
    } as never);
    assert.equal(report.system.mode, "adhere");
    const outside = report.coverage.tokensOutsideSystem.map((t) => t.name);
    assert.ok(outside.includes("--background"), "theme tokens live outside the declared system source");
  });

  it("detects frontend packages from package.json dependencies", () => {
    const files = ["apps/web/src/app/page.tsx", "packages/api/src/server.ts"];
    const scope = detectFrontendScope(
      files,
      (rel) => {
        try {
          return readFileSync(join(FIXTURE, rel), "utf8");
        } catch {
          return null;
        }
      },
      DEFAULT_DESIGN_SYSTEM_CONFIG,
    );
    assert.equal(scope.includeFile("apps/web/src/app/page.tsx"), true);
    assert.equal(scope.includeFile("packages/api/src/server.ts"), false);
    assert.match(scope.packages.find((p) => p.dir === "apps/web")!.reason, /depends on/);
  });
});

describe("Closed-loop gate: pinned baseline", () => {
  it("snapshot → clean diff PASS → tampered baseline WARN → missing baseline NO_BASELINE", async () => {
    const baselinePath = join(SCRATCH, "baseline.json");
    const { snapshot } = await snapshotDesignSystemBaseline({
      repoPath: FIXTURE,
      repoName: "fixture",
      graph,
      baselinePath,
    });
    assert.ok(Object.keys(snapshot.counts).length > 0);

    const clean = await diffDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, baselinePath });
    assert.equal(clean.gateStatus, "PASS");

    // Pretend the baseline was cleaner: one raw <button>, one undefined token and a failing contrast pair are "new"
    const tampered = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof snapshot;
    const rawKey = Object.keys(tampered.counts).find((k) => k.startsWith("rawPrimitive|"));
    const undefKey = Object.keys(tampered.counts).find((k) => k.startsWith("undefinedToken|"));
    assert.ok(rawKey && undefKey, "Expected raw-primitive and undefined-token findings in the snapshot");
    delete tampered.counts[rawKey!];
    delete tampered.counts[undefKey!];
    tampered.failingContrast = [];
    const tamperedPath = join(SCRATCH, "tampered.json");
    writeFileSync(tamperedPath, JSON.stringify(tampered), "utf8");

    const regressed = await diffDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, baselinePath: tamperedPath });
    assert.equal(regressed.gateStatus, "WARN");
    assert.equal(regressed.summary.newRawPrimitiveCount, 1);
    assert.equal(regressed.summary.newUndefinedTokenCount, 1);
    assert.equal(regressed.summary.newContrastFailureCount, 1);
    assert.ok(regressed.componentDeltas.some((d) => d.status === "REGRESSED"));
    assert.ok(regressed.remediationGuidance.some((g) => g.includes("globals.css")), "guidance names the repo's own token file");
    assert.equal(regressed.frontendPackages[0], "web");

    const none = await diffDesignSystem({
      repoPath: FIXTURE,
      repoName: "fixture",
      graph,
      baselinePath: join(SCRATCH, "missing.json"),
    });
    assert.equal(none.gateStatus, "NO_BASELINE");
    assert.ok(Object.keys(none.liveTotals).length > 0, "NO_BASELINE still reports live totals");
  });

  it("audit bootstraps a missing baseline once and never moves an existing one", async () => {
    const baselinePath = join(SCRATCH, "audit-baseline.json");
    const first = await auditDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, persistOverlays: false, baselinePath, workingTreeCheck: CLEAN });
    assert.equal(first.baseline.bootstrapped, true);
    const pinned = readFileSync(baselinePath, "utf8");
    const second = await auditDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, persistOverlays: false, baselinePath });
    assert.equal(second.baseline.written, false);
    assert.equal(readFileSync(baselinePath, "utf8"), pinned);
    const replaced = await auditDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, persistOverlays: false, baselinePath, setBaseline: true });
    assert.equal(replaced.baseline.written, true);
    assert.equal(replaced.baseline.bootstrapped, false);
  });

  it("refuses to auto-pin a baseline from a dirty in-scope working tree, but pins deliberately on request", async () => {
    const baselinePath = join(SCRATCH, "dirty-baseline.json");
    const refused = await auditDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, persistOverlays: false, baselinePath, workingTreeCheck: DIRTY });
    assert.equal(refused.baseline.refused, true);
    assert.equal(refused.baseline.written, false);
    assert.equal(refused.baseline.exists, false);
    assert.deepEqual(refused.baseline.dirtyFiles, DIRTY().dirtyFiles);
    assert.match(refused.baseline.note ?? "", /refused/);
    assert.throws(() => readFileSync(baselinePath, "utf8"), "no baseline file may be written when refused");

    // The gate stays honest: nothing pinned means NO_BASELINE, not PASS
    const diff = await diffDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, baselinePath });
    assert.equal(diff.gateStatus, "NO_BASELINE");

    // `requireCleanTree: false` is the explicit opt-out for bootstrap
    const optOut = await auditDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, persistOverlays: false, baselinePath: join(SCRATCH, "optout.json"), workingTreeCheck: DIRTY, requireCleanTree: false });
    assert.equal(optOut.baseline.written, true);

    // Explicit set_baseline pins even a dirty tree, and records that fact
    const forced = await auditDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, persistOverlays: false, baselinePath, setBaseline: true, workingTreeCheck: DIRTY });
    assert.equal(forced.baseline.written, true);
    assert.equal(forced.baseline.bootstrapped, false);
    assert.ok(forced.baseline.dirtyFiles && forced.baseline.dirtyFiles.length > 0);
    assert.equal(JSON.parse(readFileSync(baselinePath, "utf8")).workingTreeDirty, true);

    // Unknown cleanliness (not a git repo) does not block, but says so
    const unknown = await auditDesignSystem({ repoPath: FIXTURE, repoName: "fixture", graph, persistOverlays: false, baselinePath: join(SCRATCH, "unknown.json"), workingTreeCheck: () => ({ clean: null, dirtyFiles: [] }) });
    assert.equal(unknown.baseline.written, true);
    assert.match(unknown.baseline.note ?? "", /could not be verified/);
  });

  it("checkWorkingTreeClean only looks at the given in-scope directories (real git repo)", () => {
    const repo = mkdtempSync(join(SCRATCH, "git-"));
    const gitEnv = { ...process.env };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    delete gitEnv.GIT_INDEX_FILE;
    delete gitEnv.GIT_COMMON_DIR;
    delete gitEnv.GIT_PREFIX;
    delete gitEnv.GIT_OBJECT_DIRECTORY;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: gitEnv });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(join(repo, "web"));
    mkdirSync(join(repo, "api"));
    writeFileSync(join(repo, "web", "a.css"), ":root{--x:1}\n");
    writeFileSync(join(repo, "api", "s.ts"), "export {}\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    assert.equal(checkWorkingTreeClean(repo, ["web"]).clean, true);

    writeFileSync(join(repo, "api", "s.ts"), "export const x = 1;\n"); // unrelated backend edit
    assert.equal(checkWorkingTreeClean(repo, ["web"]).clean, true, "out-of-scope edits must not block");
    assert.equal(checkWorkingTreeClean(repo, ["api"]).clean, false);

    writeFileSync(join(repo, "web", "b.css"), "x{}\n"); // untracked in-scope file
    const dirty = checkWorkingTreeClean(repo, ["web"]);
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.dirtyFiles, ["web/b.css"]);
    assert.ok(dirty.commitSha);

    assert.equal(checkWorkingTreeClean(SCRATCH, ["."]).clean, null, "outside a git repo cleanliness is unknown");
  });

  it("compares by occurrence count: a second use of an already-baselined value is still new", () => {
    const rec = (n: number): FindingRecord => ({
      category: "arbitraryTailwind",
      key: findingKey("arbitraryTailwind", "a.tsx", "Comp", "w-[13px]"),
      filePath: "a.tsx",
      lineNumber: n,
      label: "w-[13px]",
    });
    const diff = diffFindings({ [rec(1).key]: 1 }, [rec(1), rec(9)]);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0]!.lineNumber, 9);
    assert.deepEqual(diffFindings({ [rec(1).key]: 2 }, [rec(1)]).resolved, [{ key: rec(1).key, removed: 1 }]);
  });
});

describe("Plugin Presentation Contract (design-system)", () => {
  async function overlays() {
    const res = await runChompPlugin(createDesignSystemPlugin(), {
      repoPath: FIXTURE,
      repoName: "fixture",
      graph,
      persist: false,
    });
    return res;
  }

  it("emits a valid, idempotent presentation on the package overlay with basic info and selectable metric cards", async () => {
    const res = await overlays();
    assert.deepEqual(res.presentationWarnings, [], "design-system presentation must pass the contract without warnings");
    const pkg = res.overlays.find((o) => o.payload?.isPackageOverlay === true);
    assert.ok(pkg, "Expected a package overlay for apps/web");
    const p = readPresentationFromPayload(pkg.payload);
    assert.ok(p, "package overlay carries payload.presentation");
    assert.deepEqual(sanitizePluginPresentation(p).presentation, p, "sanitize is idempotent on a conforming presentation");

    assert.deepEqual(p.sections.map((s) => s.id), ["design-system"], "single flat section without nested accordions");
    const section = p.sections[0]!;
    assert.equal(section.blocks.length, 2);
    assert.equal(section.blocks[0]!.kind, "keyValue");
    assert.equal(section.blocks[1]!.kind, "metrics");

    // Pre-computed spotlight views are attached to summary.views for non-zero issue clusters
    assert.ok(p.summary?.views && p.summary.views.length > 0, "package summary includes spotlight views for active issue clusters");
    assert.ok(p.summary.views.every((v) => v.highlightNodeIds.length > 0 && v.title.length > 0));
    assert.ok((p.summary?.issueCount ?? 0) > 0, "issue count is tracked on summary");

    // Metrics expose all four pillars with high-level detail line items
    const metricsBlock = section.blocks[1]!;
    if (metricsBlock.kind === "metrics") {
      assert.deepEqual(
        metricsBlock.items.map((m) => m.id),
        ["tokenAdherence", "atomAdoption", "dryness", "encapsulation"]
      );
      const atomMetric = metricsBlock.items.find((m) => m.id === "atomAdoption")!;
      assert.ok(atomMetric.items && atomMetric.items.length > 0, "Shared component reuse metric carries line items");
      const drynessMetric = metricsBlock.items.find((m) => m.id === "dryness")!;
      assert.ok(
        drynessMetric.items &&
          drynessMetric.items.some((i) => i.label.includes("SubmitButton") && i.detail?.includes("Similar")),
        "No duplicate UI metric carries minimal name + relative grouping line items"
      );
    }
    assert.equal(p.summary?.metrics?.length, 4);
  });

  it("emits component presentations using the keyValue label/value visual system", async () => {
    const res = await overlays();
    const legacy = res.overlays.find((o) => {
      const p = readPresentationFromPayload(o.payload);
      const kv = p?.sections[0]?.blocks.find((b) => b.kind === "keyValue");
      return (
        kv?.kind === "keyValue" &&
        kv.items.some((i) => i.label === "Hardcoded values" && String(i.value).includes('color="#ff0000"'))
      );
    });
    assert.ok(legacy, "Legacy component overlay carries Hardcoded values in keyValue block");
    const p = readPresentationFromPayload(legacy.payload)!;
    assert.equal(p.summary?.status, "warn");
    assert.equal(p.sections[0]!.blocks.length, 1);
    assert.equal(p.sections[0]!.blocks[0]!.kind, "keyValue");

    const submit = res.overlays.find((o) => {
      const kv = readPresentationFromPayload(o.payload)?.sections[0]?.blocks.find((b) => b.kind === "keyValue");
      return (
        kv?.kind === "keyValue" &&
        kv.items.some((i) => i.label === "Similar UI" && String(i.value).includes("Button family"))
      );
    });
    assert.ok(submit, "a Button-family member carries Similar UI in keyValue block");
  });

  it("the runner drops invalid presentations (and reports why) instead of failing", () => {
    const { overlays: out, warnings } = enforcePresentationContract(
      [
        { repositoryId: "r", entityId: "a", layer: "L1_DESIGN_SYSTEM", source: "x", payload: { keep: 1, presentation: { version: 99 } } },
        { repositoryId: "r", entityId: "b", layer: "L1_DESIGN_SYSTEM", source: "x", payload: { presentation: { version: 1, sections: [{ id: "s", title: "S", blocks: [{ kind: "text", text: "ok" }, { kind: "nope" }] }] } } },
      ],
      "x"
    );
    assert.deepEqual(out[0]!.payload, { keep: 1 });
    assert.ok(warnings.some((w) => w.includes("unsupported presentation version")));
    const kept = readPresentationFromPayload(out[1]!.payload)!;
    assert.equal(kept.sections[0]!.blocks.length, 1);
    assert.ok(warnings.some((w) => w.includes('unknown block kind "nope"')));
  });
});

describe("Scanner assumes no repo-specific APIs", () => {
  it("does not mistake i18n `t(a, b, c)` or `css()` calls for canvas slot provenance unless the recorder factory is configured", () => {
    const src = [
      'import { useTranslation } from "react-i18next";',
      "export function Label() {",
      "  const { t } = useTranslation();",
      '  const text = t("ns", "key", "fallback");',
      "  return <span>{text}</span>;",
      "}",
    ].join("\n");
    const scan = scanTsxOrTsFile("apps/web/src/Label.tsx", src);
    const bucket = scan.functionsAndClasses.get("Label")!;
    assert.equal(bucket.usesSlotRecorder, false);
    assert.ok(!bucket.stylingConventions.has("pixi-canvas"));
  });

  it("derives stylesheet classes, CSS Modules usage and cva variant axes without any naming prefix", () => {
    const src = [
      'import styles from "./card.module.css";',
      'import { cva } from "class-variance-authority";',
      'const tone = cva("px-2", { variants: { tone: { calm: "bg-muted", loud: "bg-red-500" } } });',
      "export function Card({ tone: t }: { tone?: 'calm' | 'loud' }) {",
      '  return <div className={`${styles.card} legacy-box ${tone({ tone: t })}`} />;',
      "}",
    ].join("\n");
    const scan = scanTsxOrTsFile("apps/web/src/Card.tsx", src, {
      knownCssClasses: new Set(["legacy-box"]),
    });
    const bucket = scan.functionsAndClasses.get("Card")!;
    assert.ok(bucket.stylingConventions.has("css-modules"));
    assert.ok(bucket.stylingConventions.has("css-classes"), "`legacy-box` is defined in the repo's CSS");
    assert.deepEqual(scan.variantAxes, { tone: ["calm", "loud"] });
    assert.deepEqual(bucket.propContract.find((p) => p.name === "tone")?.variants, ["calm", "loud"]);
  });
});

describe("Color engine and value clustering", () => {
  it("parses modern syntaxes and returns null (unknown) for what it cannot evaluate", () => {
    assert.deepEqual(parseCssColorString("hsl(0 0% 100%)"), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseCssColorString("rgb(0 0 0 / 50%)"), { r: 0, g: 0, b: 0, a: 0.5 });
    assert.deepEqual(parseCssColorString("rgba(255, 0, 0, 0.5)"), { r: 255, g: 0, b: 0, a: 0.5 });
    const white = parseCssColorString("oklch(1 0 0)")!;
    assert.ok(white.r >= 254 && white.g >= 254 && white.b >= 254);
    const black = parseCssColorString("oklch(0 0 0)")!;
    assert.ok(black.r <= 1 && black.g <= 1 && black.b <= 1);
    assert.equal(parseCssColorString("color-mix(in srgb, red, blue)"), null);
    assert.equal(parseCssColorString("currentColor"), null);
  });

  it("OKLab distance separates visibly different colors from near-identical ones", () => {
    const d = (a: string, b: string) => oklabDistance(toOklab(parseCssColorString(a)!), toOklab(parseCssColorString(b)!));
    assert.ok(d("#333333", "#323232") < 0.01);
    assert.ok(d("#333333", "#ff0000") > 0.3);
  });

  it("clusters near-identical colors and snaps lengths per category", () => {
    const occ = (kind: "color" | "length", value: string, context: string, n: number): LiteralValueOccurrence => ({
      kind,
      value,
      surface: "css-rule",
      context,
      filePath: `f${n}.css`,
      lineNumber: n,
      snippet: value,
    });
    const proposals = clusterLiteralValues(
      [
        occ("color", "#333333", "color", 1),
        occ("color", "#323232", "color", 2),
        occ("color", "#343434", "color", 3),
        occ("length", "12px", "padding", 4),
        occ("length", "13px", "padding", 5),
        occ("length", "12px", "font-size", 6),
        occ("length", "12px", "font-size", 7),
      ],
      [{ name: "--space-3", value: "12px" }],
      DEFAULT_DESIGN_SYSTEM_CONFIG.clustering,
    );
    const color = proposals.find((p) => p.kind === "color")!;
    assert.equal(color.members.length, 3);
    assert.equal(color.occurrenceCount, 3);

    const space = proposals.find((p) => p.kind === "length" && p.category === "space")!;
    assert.equal(space.existingTokenMatch?.name, "--space-3");
    const type = proposals.find((p) => p.kind === "length" && p.category === "type")!;
    assert.equal(type.existingTokenMatch, undefined, "a font-size cluster must not match a spacing token");
  });
});

describe("Contrast discovery across @theme bridges, -contrast/-surface/-on-*, and JSX Tailwind pairs", () => {
  it("audits @theme bridged pairs, --alpha() surfaces, light-theme AA failures, and reports N of M candidates honestly", async () => {
    const bridgeFixture = resolve(REPO_ROOT, "fixtures/design-system/contrast-bridge");
    const bridgeExpected = JSON.parse(readFileSync(join(bridgeFixture, "expected.json"), "utf8"));
    const bridgeGraph = analyzeTarget(bridgeFixture);
    const runRes = await runChompPlugin(designSystemPluginModule, {
      repoPath: bridgeFixture,
      repoName: "contrast-bridge",
      graph: bridgeGraph,
      persist: false,
    });
    const report = runRes.summary.report as DesignSystemAnalysisReport;

    const audited = report.diagnostics.contrastAudits.map((c) => c.pairId).sort();
    assert.deepEqual(audited, [...bridgeExpected.contrast.audited].sort());
    assert.deepEqual(
      report.diagnostics.contrastFailures.map((c) => c.pairId),
      bridgeExpected.contrast.failing,
    );

    const successAudit = report.diagnostics.contrastAudits.find(
      (c) => c.pairId === "naming:--success-on---success-surface",
    );
    assert.ok(successAudit?.light && successAudit?.dark);
    assert.equal(successAudit.light.passes, false);
    assert.equal(successAudit.dark.passes, true);

    assert.equal(report.summary.contrastPairsAudited, bridgeExpected.contrast.auditedCount);
    assert.equal(report.summary.contrastCandidateCount, bridgeExpected.contrast.candidateCount);
    assert.ok(report.summary.contrastCandidateCount > report.summary.contrastPairsAudited);

    const unresolvedActual = report.coverage.contrastUnresolved.map((u) => ({
      pairId: u.pairId,
      foregroundToken: u.foregroundToken,
      backgroundToken: u.backgroundToken,
      reason: u.reason,
    }));
    assert.deepEqual(unresolvedActual, bridgeExpected.contrast.unresolved);

    const identity = (s: string) => s;
    const cliLines = designSystemPluginModule.formatCliSummary!(runRes, {
      bold: identity,
      dim: identity,
      green: identity,
      yellow: identity,
      cyan: identity,
    });
    const contrastLine = cliLines.find((l) => l.includes("WCAG Contrast:"));
    assert.ok(contrastLine, "Expected WCAG Contrast line in CLI summary");
    assert.match(
      contrastLine!,
      /7 of 8 candidate pairs audited \(6\/7 PASS, 1 fail, 1 unresolved\)/,
    );
  });
});
