/**
 * @fileoverview CLI command implementation for evaluating structural extraction health.
 *
 * The `health` command runs deterministic AST extraction against a target repository
 * and calculates four key structural health metrics:
 * 1. Connectivity Rate: Resolvability of cross-entity structural relationships.
 * 2. Entity Type Coverage: Proportion of entities with identified concrete types.
 * 3. Parent Coverage: Proportion of contracts attached to parent boundaries.
 * 4. Scope Purity: Proportion of entities belonging to user/application scope.
 *
 * @module @chomp/cli/commands/health
 */

import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import {
  CORE_EXTRACTOR_VERSION,
  analyzeTarget,
  auditFrameworkCoverage,
  computeStructuralHealthMetrics,
  StructuralNode,
  StructuralEdge,
} from "@chomp/core";
import { applyActivePluginProjections } from "@chomp/mcp";
import { getGitInfo, resolveRepoName } from "../utils/git.js";
import {
  loadExcludeWorkspaces,
  printFrameworkWarnings,
  printUnregisteredShapeHint,
} from "../utils/branding.js";
import { resolveDefaultCliTarget } from "../utils/masterContext.js";

/**
 * Runs the 4-metric Chomp structural health check on `targetPath` and prints results.
 * Returns `true` if all metrics pass, `false` otherwise.
 */
export function runHealthCheck(targetPath: string): boolean {
  const { commitSha } = getGitInfo(targetPath);
  const excludeWorkspaces = loadExcludeWorkspaces(targetPath);

  console.log(`Analyzing repository: ${targetPath}...`);
  const rawGraph = analyzeTarget(
    targetPath,
    CORE_EXTRACTOR_VERSION,
    commitSha,
    excludeWorkspaces,
  );

  const graph = applyActivePluginProjections(rawGraph, {
    repoPath: targetPath,
  });
  const shimmedEdgeCount = graph.edges.filter(
    (e) => e.metadata?.source === "USER_SHIM",
  ).length;

  const allEntities: Array<StructuralNode | StructuralEdge> = [
    ...graph.nodes,
    ...graph.edges,
  ];

  const healthMetrics = computeStructuralHealthMetrics(graph);
  const {
    connectivityRate,
    rawConnectivityRate,
    knowableConnectivityRate,
    entityTypeCoverage,
    parentCoverage,
    scopePurity,
    callResolutionCounts,
  } = healthMetrics;
  const unprovableCount = callResolutionCounts.unprovableFallbackCount;

  console.log("\n--- Structural Health Metrics ---\n");

  const metrics = [
    {
      Metric: "Connectivity Rate",
      Value: `${connectivityRate.toFixed(1)}%`,
      Target: ">80%",
      Status: connectivityRate >= 80 ? "✅ PASS" : "❌ FAIL",
    },
    {
      Metric: "Entity Type Coverage",
      Value: `${entityTypeCoverage.toFixed(1)}%`,
      Target: "100%",
      Status: entityTypeCoverage === 100 ? "✅ PASS" : "❌ FAIL",
    },
    {
      Metric: "Parent Coverage",
      Value: `${parentCoverage.toFixed(1)}%`,
      Target: "100%",
      Status: parentCoverage === 100 ? "✅ PASS" : "❌ FAIL",
    },
    {
      Metric: "Scope Purity",
      Value: `${scopePurity.toFixed(1)}%`,
      Target: ">95%",
      Status: scopePurity >= 95 ? "✅ PASS" : "❌ FAIL",
    },
  ];

  console.table(metrics);

  console.log("\n--- Informational Counts ---\n");
  const callCount = graph.edges.filter((r) => r.entityType === "CALL").length;
  const rendersCount = graph.edges.filter((r) => r.entityType === "RENDERS").length;
  const coverage = auditFrameworkCoverage(targetPath, graph, excludeWorkspaces);

  const incomingTargetIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.targetId) incomingTargetIds.add(edge.targetId);
  }
  const ingressEntityTypes = new Set([
    "API_ENDPOINT",
    "HTTP_ENDPOINT",
    "HTTP_ROUTE",
    "NEXTJS_PAGE",
    "NEXTJS_LAYOUT",
    "NEXTJS_MIDDLEWARE",
    "SERVER_ACTION",
    "EVENT_LISTENER",
    "MCP_TOOL",
    "PAYLOAD_ENDPOINT",
    "PAYLOAD_JOB",
    "PAYLOAD_HOOK",
  ]);
  const nonExecutableEntityTypes = new Set([
    "EXPORTED_TYPE",
    "TYPE_DEFINITION",
    "DB_SCHEMA",
    "VALIDATOR_SCHEMA",
    "COLLECTION_CONFIG",
    "SERVER_GUARD",
    "ROUTE_CONFIG",
    "NEXTJS_ROUTE_CONFIG",
    "METADATA_EXPORT",
    "NEXTJS_METADATA",
    "EXPRESS_ROUTE_PARAM",
  ]);

  const orphanContracts = graph.nodes.filter(
    (n) =>
      n.type === "CONTRACT" &&
      (n.scope ?? "USER") === "USER" &&
      !nonExecutableEntityTypes.has(n.entityType) &&
      !ingressEntityTypes.has(n.entityType) &&
      !incomingTargetIds.has(n.id),
  );

  const unlinkedImportedOrphans = orphanContracts.filter((n) => {
    const inc = Array.isArray(n.metadata?.unresolvedIncoming)
      ? n.metadata.unresolvedIncoming
      : [];
    return inc.some((r: any) => r?.reason !== "imported-but-never-invoked");
  });
  const importedNeverInvokedOrphans = orphanContracts.filter((n) => {
    const inc = Array.isArray(n.metadata?.unresolvedIncoming)
      ? n.metadata.unresolvedIncoming
      : [];
    return (
      inc.length > 0 &&
      inc.every((r: any) => r?.reason === "imported-but-never-invoked")
    );
  });
  const unreferencedExportOrphans = orphanContracts.filter((n) => {
    const inc = Array.isArray(n.metadata?.unresolvedIncoming)
      ? n.metadata.unresolvedIncoming
      : [];
    return inc.length === 0;
  });

  const counts = [
    { Entity: "CALL Relationships", Count: callCount },
    { Entity: "RENDERS Relationships", Count: rendersCount },
    ...(shimmedEdgeCount > 0
      ? [{ Entity: "User-Defined Shims Bridged (L1_SHIMS)", Count: shimmedEdgeCount }]
      : []),
    { Entity: "Unprovable Calls (excluded from gate)", Count: unprovableCount },
    {
      Entity: "Raw CALL-family Resolution (all edges)",
      Count: `${rawConnectivityRate.toFixed(1)}%`,
    },
    {
      Entity: "Knowable Connectivity Rate (RESOLVED / [RESOLVED + KNOWABLE_GAP])",
      Count: `${knowableConnectivityRate.toFixed(1)}%`,
    },
    {
      Entity: "Call Class: RESOLVED",
      Count: callResolutionCounts.resolvedCount,
    },
    {
      Entity: "Call Class: KNOWABLE_GAP (actionable)",
      Count: callResolutionCounts.knowableGapCount,
    },
    {
      Entity: "Call Class: DYNAMIC_BOUNDARY (Road Ends)",
      Count: callResolutionCounts.dynamicBoundaryCount,
    },
    {
      Entity: "Call Class: PLATFORM_PRIMITIVE (builtin)",
      Count: callResolutionCounts.platformPrimitiveCount,
    },
    {
      Entity: "Orphan Contracts (Should Connect / Unlinked Import)",
      Count: unlinkedImportedOrphans.length,
    },
    {
      Entity: "Orphan Contracts (Imported, Never Invoked)",
      Count: importedNeverInvokedOrphans.length,
    },
    {
      Entity: "Orphan Contracts (Unreferenced Exports)",
      Count: unreferencedExportOrphans.length,
    },
    {
      Entity: "Dark Files (0 contracts / 0 init edges)",
      Count: coverage.darkFiles.length,
    },
    {
      Entity: "BOUNDARIES",
      Count: graph.nodes.filter((n) => n.type === "BOUNDARY").length,
    },
    {
      Entity: "CONTRACTS",
      Count: graph.nodes.filter((n) => n.type === "CONTRACT").length,
    },
    { Entity: "RELATIONSHIPS", Count: graph.edges.length },
    {
      Entity: "OPEN CONNECTORS",
      Count: graph.nodes.filter((n) => n.type === "OPEN_CONNECTOR").length,
    },
    { Entity: "TOTAL ENTITIES", Count: allEntities.length },
  ];

  console.table(counts);

  const unresolvedImportEdges = graph.edges.filter(
    (e) =>
      !e.targetId &&
      (e.entityType === "CALL" || e.entityType === "RENDERS") &&
      typeof e.metadata?.unresolvedReason === "string",
  );

  if (
    unresolvedImportEdges.length > 0 ||
    unlinkedImportedOrphans.length > 0 ||
    importedNeverInvokedOrphans.length > 0
  ) {
    console.log("\n--- Unresolved Connections & Orphan Diagnostics ---\n");
    const diagRows: Array<{
      Kind: string;
      Entity: string;
      PeerOrSymbol: string;
      Location: string;
      Reason: string;
    }> = [];

    for (const edge of unresolvedImportEdges.slice(0, 15)) {
      const ev = Array.isArray(edge.evidence) ? edge.evidence[0] : edge.evidence;
      diagRows.push({
        Kind: `Unresolved ${edge.entityType}`,
        Entity: edge.name,
        PeerOrSymbol: `${edge.metadata?.importSpecifier ?? "?"} :: ${edge.metadata?.targetSymbol ?? "?"}`,
        Location: ev?.filePath ? `${ev.filePath}:${ev.lineNumber ?? 1}` : "unknown",
        Reason: String(edge.metadata?.unresolvedReason ?? "unresolved-target"),
      });
    }

    for (const orphan of [...unlinkedImportedOrphans, ...importedNeverInvokedOrphans].slice(0, 15)) {
      const inc = Array.isArray(orphan.metadata?.unresolvedIncoming)
        ? orphan.metadata.unresolvedIncoming
        : [];
      for (const ref of inc.slice(0, 3)) {
        diagRows.push({
          Kind: "Orphan Expected Caller",
          Entity: orphan.name,
          PeerOrSymbol: `${ref.callerName} [${ref.usageKind}]`,
          Location: `${ref.filePath}:${ref.lineNumber}`,
          Reason: String(ref.reason),
        });
      }
    }

    if (diagRows.length > 0) {
      console.table(diagRows);
    }
  }

  if (coverage.warnings.length > 0) {
    console.log("");
    printFrameworkWarnings(coverage.warnings);
  }
  printUnregisteredShapeHint(graph, resolveRepoName(targetPath), coverage.darkFiles);

  const allPass = metrics.every((m) => m.Status === "✅ PASS");
  if (!allPass) {
    console.error(
      "\nHealth check failed: One or more metrics did not meet the target.",
    );
  } else {
    console.log("\nHealth check passed! Repository graph is structurally sound.");
  }
  return allPass;
}

export function registerHealthCommand(program: Command): void {
  program
    .command("health [path]")
    .description(
      "Compute extraction health metrics for a repository (defaults to current directory)",
    )
    .option(
      "--repo <path>",
      "Path to a directory to analyze (alias for [path])",
    )
    .action((inputPath: string | undefined, options: { repo?: string }) => {
      const baseDir = process.env.INIT_CWD ?? process.cwd();
      const { targetPath } = resolveDefaultCliTarget(
        options.repo ?? inputPath,
        baseDir,
      );

      if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
        console.error(
          `Error: Target path ${targetPath} is not a valid directory.`,
        );
        process.exit(1);
      }

      const allPass = runHealthCheck(targetPath);
      if (!allPass) {
        process.exit(1);
      }
    });
}
