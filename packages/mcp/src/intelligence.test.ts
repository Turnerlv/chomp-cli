import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { analyzeTarget, type RepresentationGraph } from "@chomp/core";
import {
  auditGraphHealth,
  buildActiveViewUrl,
  checkGraphBoundaries,
  computeBlastRadius,
  filterNodesForMcp,
  findGraphRedundancies,
  formatEnrichNodesSummary,
  hydrateNodeOverlays,
  resolveViewNodeIds,
  resolveViewTargetAltitude,
} from "./intelligence.js";
import {
  invalidateMcpGraphCache,
  loadActiveGraphCached,
  resolveRepoGitBranch,
  withMcpToolErrorBoundary,
  withStorage,
} from "./index.js";

function createSampleGraph(): RepresentationGraph {
  return {
    extractorVersion: "0.2.39",
    analyzedAt: "2026-10-29T00:00:00.000Z",
    nodes: [
      {
        id: "du-api",
        name: "Deployment Unit: @sample/api",
        type: "BOUNDARY",
        entityType: "DEPLOYMENT_UNIT",
        patternId: "boundary.deployment-unit",
        scope: "USER",
        evidence: { filePath: "packages/api" },
      },
      {
        id: "du-core",
        name: "Deployment Unit: @sample/core",
        type: "BOUNDARY",
        entityType: "DEPLOYMENT_UNIT",
        patternId: "boundary.deployment-unit",
        scope: "USER",
        evidence: { filePath: "packages/core" },
      },
      {
        id: "route-orders",
        name: "HTTP Endpoint: POST /api/orders",
        type: "CONTRACT",
        entityType: "HTTP_ENDPOINT",
        patternId: "contract.express-route",
        parentBoundaryId: "du-api",
        scope: "USER",
        evidence: { filePath: "packages/api/src/routes.ts", lineNumber: 10 },
      },
      {
        id: "route-dead",
        name: "HTTP Endpoint: GET /api/dead",
        type: "CONTRACT",
        entityType: "HTTP_ENDPOINT",
        patternId: "contract.express-route",
        parentBoundaryId: "du-api",
        scope: "USER",
        evidence: { filePath: "packages/api/src/routes.ts", lineNumber: 25 },
      },
      {
        id: "fn-relay",
        name: "Exported Function: forwardOrder",
        type: "CONTRACT",
        entityType: "EXPORTED_FUNCTION",
        patternId: "contract.exported-function",
        parentBoundaryId: "du-api",
        scope: "USER",
        evidence: { filePath: "packages/api/src/relay.ts", lineNumber: 5 },
      },
      {
        id: "fn-process",
        name: "Exported Function: processOrder",
        type: "CONTRACT",
        entityType: "EXPORTED_FUNCTION",
        patternId: "contract.exported-function",
        parentBoundaryId: "du-core",
        scope: "USER",
        metadata: {
          inputTypes: ["OrderInput"],
          outputType: "OrderReceipt",
        },
        evidence: { filePath: "packages/core/src/orders.ts", lineNumber: 12 },
      },
      {
        id: "fn-orphan",
        name: "Exported Function: unusedHelper",
        type: "CONTRACT",
        entityType: "EXPORTED_FUNCTION",
        patternId: "contract.exported-function",
        parentBoundaryId: "du-core",
        scope: "USER",
        evidence: { filePath: "packages/core/src/unused.ts", lineNumber: 1 },
      },
      {
        id: "oc-db",
        name: "DB Call: db.insert",
        type: "OPEN_CONNECTOR",
        entityType: "DB_OPERATION",
        patternId: "open-connector.db-call",
        scope: "USER",
        evidence: { filePath: "packages/core/src/orders.ts", lineNumber: 20 },
      },
    ],
    edges: [
      {
        id: "e-route-relay",
        name: "Call: forwardOrder()",
        type: "RELATIONSHIP",
        entityType: "CALL",
        patternId: "relationship.function-call",
        sourceId: "route-orders",
        targetId: "fn-relay",
        status: "DETERMINISTIC",
        confidence: "HIGH",
        scope: "USER",
        evidence: { filePath: "packages/api/src/routes.ts", lineNumber: 12 },
      },
      {
        id: "e-relay-process",
        name: "Call: processOrder()",
        type: "RELATIONSHIP",
        entityType: "CALL",
        patternId: "relationship.function-call",
        sourceId: "fn-relay",
        targetId: "fn-process",
        status: "DETERMINISTIC",
        confidence: "HIGH",
        scope: "USER",
        evidence: { filePath: "packages/api/src/relay.ts", lineNumber: 6 },
      },
      {
        id: "e-process-db",
        name: "Call: db.insert()",
        type: "RELATIONSHIP",
        entityType: "DB_OPERATION",
        patternId: "relationship.db-operation",
        sourceId: "fn-process",
        targetId: "oc-db",
        status: "DETERMINISTIC",
        confidence: "HIGH",
        scope: "USER",
        evidence: { filePath: "packages/core/src/orders.ts", lineNumber: 20 },
      },
      {
        id: "e-unresolved",
        name: "Call: dynamicBus.dispatch()",
        type: "RELATIONSHIP",
        entityType: "CALL",
        patternId: "relationship.inferred-method-call",
        sourceId: "fn-process",
        status: "INFERRED",
        confidence: "MEDIUM",
        scope: "USER",
        evidence: {
          filePath: "packages/core/src/orders.ts",
          lineNumber: 24,
          snippet: "dynamicBus.dispatch(order)",
          evidenceRole: "syntax-call",
        },
      },
    ],
  };
}

describe("@chomp/mcp Architectural Intelligence Engine", () => {
  it("filterNodesForMcp and resolveViewNodeIds support search_term and packageName fast path", () => {
    const graph = createSampleGraph();
    const coreNodes = filterNodesForMcp(graph, {
      packageName: "core",
      searchTerm: "processOrder",
    });
    assert.equal(coreNodes.length, 1);
    assert.equal(coreNodes[0].id, "fn-process");

    const viewIds = resolveViewNodeIds(graph, ["route-orders"], "processOrder", "core");
    assert.deepEqual(viewIds, ["route-orders", "fn-process"]);
  });

  it("auditGraphHealth surfaces orphans, dead-end ingress, and unresolved call hotspots with Agent-Readiness guidance", () => {
    const graph = createSampleGraph();
    const report = auditGraphHealth(graph);

    assert.equal(report.healthGate.orphanContractCount, 1);
    assert.equal(report.orphanContracts[0].node.id, "fn-orphan");

    assert.equal(report.healthGate.deadEndIngressCount, 1);
    assert.equal(report.deadEndIngress[0].node.id, "route-dead");

    assert.equal(report.healthGate.unresolvedHotspotCount, 1);
    assert.equal(report.unresolvedHotspots[0].node.id, "fn-process");
    assert.ok(
      report.unresolvedHotspots[0].agentReadinessOpportunity.includes("Map Visibility Opportunity")
    );
  });

  it("findGraphRedundancies detects 1-to-1 pass-through middlemen", () => {
    const graph = createSampleGraph();
    const report = findGraphRedundancies(graph);

    assert.equal(report.passThroughMiddlemen.length, 1);
    assert.equal(report.passThroughMiddlemen[0].middleman.id, "fn-relay");
    assert.equal(report.passThroughMiddlemen[0].singleTarget.id, "fn-process");
    assert.equal(report.passThroughMiddlemen[0].crossesPackageBoundary, true);
  });

  it("checkGraphBoundaries classifies package tiers and cross-package dependencies", () => {
    const graph = createSampleGraph();
    const report = checkGraphBoundaries(graph);

    assert.equal(report.status, "CLEAN");
    const apiLayer = report.packageLayers.find((p) => p.packageName === "api");
    const coreLayer = report.packageLayers.find((p) => p.packageName === "core");
    assert.equal(apiLayer?.architecturalTier, "ENTRY_APPLICATION");
    assert.equal(coreLayer?.architecturalTier, "FOUNDATION_CORE");
  });

  it("computeBlastRadius traces upstream callers, downstream side-effects, affected entry points, and Port Valves", () => {
    const graph = createSampleGraph();
    const blast = computeBlastRadius(graph, {
      searchTerm: "processOrder",
      packageName: "core",
    });

    assert.equal(blast.found, true);
    assert.equal(blast.targetNodes[0].id, "fn-process");
    assert.equal(blast.portValves.length, 1);
    assert.deepEqual(blast.portValves[0].inputTypes, ["OrderInput"]);
    assert.equal(blast.portValves[0].outputType, "OrderReceipt");

    const callerIds = blast.upstreamCallers.map((u) => u.node.id);
    assert.ok(callerIds.includes("fn-relay"));
    assert.ok(callerIds.includes("route-orders"));
    assert.equal(blast.affectedEntryPoints[0].id, "route-orders");
    assert.equal(blast.externalSideEffects[0].connector.id, "oc-db");
  });

  it("auditGraphHealth clusters signal instances by deterministic shape key (v5 Loop 1/3)", () => {
    // Ground truth: fixtures/test-repos/shape-keys/expected.json. Of its 15 unresolved call edges
    // only `gateway.send()` (relationship.inferred-method-call, MEDIUM) is an actionable
    // unresolved target; the 14 LOW-confidence invoke-returned-function fallbacks are hidden by the
    // classifier policy. Both exported contracts are unreachable from any entry => 2 orphans.
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const graph = analyzeTarget(resolve(repoRoot, "fixtures/test-repos/shape-keys"));
    const report = auditGraphHealth(graph);

    const opaque = report.signalClusters.clusters.find(
      (c) => c.signal === "OPAQUE_BODY" && c.shapeKey === "sk1/CALL/Import/Prop(Id)"
    );
    assert.ok(opaque, "gateway.send() forms an OPAQUE_BODY cluster keyed by its call shape");
    assert.equal(opaque.instanceCount, 1);
    assert.equal(opaque.examples[0].name, "gateway.send()");

    const orphans = report.signalClusters.clusters.find((c) => c.signal === "ORPHAN_CONTRACT");
    assert.ok(orphans);
    assert.equal(orphans.shapeKey, "sk1/ORPHAN/EXPORTED_FUNCTION/contract.exported-function");
    assert.equal(orphans.instanceCount, 2);

    assert.equal(report.signalClusters.unclassified.instanceCount, 0);
  });

  it("auditGraphHealth reports instances without a shape key as unclassified, not guessed", () => {
    const report = auditGraphHealth(createSampleGraph());
    // The hand-built sample graph predates shape keys: its unresolved call must stay unknown.
    assert.equal(report.signalClusters.unclassified.instanceCount, 1);
    assert.ok(
      report.signalClusters.clusters.every((c) => c.signal === "ORPHAN_CONTRACT"),
      "only orphan clusters (keyed from the extractor vocabulary) are classified"
    );
  });

  it("dogfoods all 4 intelligence tools against the @chomp/mcp package graph with 100% connectivity and 0 unresolved calls", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const rawGraph = analyzeTarget(resolve(repoRoot, "packages"));
    const liveGraph: RepresentationGraph = {
      ...rawGraph,
      nodes: rawGraph.nodes.filter((n) => (n.scope ?? "USER") === "USER"),
      edges: rawGraph.edges.filter((e) => (e.scope ?? "USER") === "USER"),
    };

    const health = auditGraphHealth(liveGraph);
    assert.equal(health.healthGate.connectivityRate, 100);
    assert.equal(health.healthGate.status, "PASS");
    assert.equal(health.healthGate.totalUnresolvedCalls, 0);

    const boundaries = checkGraphBoundaries(liveGraph);
    assert.equal(boundaries.circularDependencies.packageCycles.length, 0);

    const redundancies = findGraphRedundancies(liveGraph);
    assert.ok(
      redundancies.duplicateStorySequences.length +
        redundancies.passThroughMiddlemen.length >=
        1
    );

    const blast = computeBlastRadius(liveGraph, {
      searchTerm: "auditGraphHealth",
    });
    assert.equal(blast.found, true);
    assert.ok(
      blast.upstreamCallers.some((u) => u.node.name.includes("chomp_audit_health"))
    );
  });

  it("hydrateNodeOverlays and formatEnrichNodesSummary support selective MCP hydration and per-layer write counts ([PAT-DB-05])", () => {
    const graph = createSampleGraph();
    const overlays = [
      {
        entityId: "fn-process",
        layer: "L1_SEMANTIC",
        source: "chomp_enrich_nodes",
        payload: { humanLabel: "Checkout Order Processor", domain: "billing" },
      },
      {
        entityId: "fn-process",
        layer: "L1_DESIGN_SYSTEM",
        source: "ui-audit-plugin",
        payload: { tier: "Service" },
      },
    ];

    const overlaysByEntityId = new Map([["fn-process", overlays]]);
    const matched = filterNodesForMcp(graph, {
      searchTerm: "Checkout Order",
      overlaysByEntityId,
    });
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, "fn-process");

    // 1. Default structural query: includeOverlays omitted & layers omitted -> no overlays attached
    const compact = hydrateNodeOverlays(matched, overlays);
    assert.equal(compact[0].overlays, undefined);

    // 2. Filtered by layers: implicitly hydrates only the requested layer(s)
    const designOnly = hydrateNodeOverlays(matched, overlays, {
      layers: ["L1_DESIGN_SYSTEM"],
    });
    assert.equal(designOnly[0].overlays?.length, 1);
    assert.equal(designOnly[0].overlays?.[0].layer, "L1_DESIGN_SYSTEM");

    // 3. Explicit includeOverlays: true -> hydrates all overlays
    const allHydrated = hydrateNodeOverlays(matched, overlays, {
      includeOverlays: true,
    });
    assert.equal(allHydrated[0].overlays?.length, 2);

    // 4. Per-layer write count summary formatting
    const msg = formatEnrichNodesSummary(
      { L1_SEMANTIC: 2, L1_DESIGN_SYSTEM: 5 },
      1
    );
    assert.equal(
      msg,
      "Successfully enriched 7 node(s) (L1_SEMANTIC: 2, L1_DESIGN_SYSTEM: 5) and saved 1 classification rule(s) to .chomp/rules.json."
    );
  });

  it("checkGraphBoundaries never reports CLEAN when >= 2 DEPLOYMENT_UNITs with contracts are completely isolated (ISOLATED_DEPLOYMENT_UNITS)", () => {
    const isolatedGraph: RepresentationGraph = {
      extractorVersion: "0.2.39",
      analyzedAt: "2026-11-03T00:00:00.000Z",
      nodes: [
        {
          id: "du-web",
          name: "Deployment Unit: @acme/web",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/web" },
        },
        {
          id: "du-server",
          name: "Deployment Unit: @acme/server",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/server" },
        },
        {
          id: "fn-client",
          name: "Exported Function: renderDashboard",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "apps/web/src/dashboard.tsx", lineNumber: 10 },
        },
        {
          id: "fn-server",
          name: "Exported Function: queryStats",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-server",
          scope: "USER",
          evidence: { filePath: "apps/server/src/stats.ts", lineNumber: 15 },
        },
      ],
      edges: [],
    };

    const boundaries = checkGraphBoundaries(isolatedGraph);
    assert.notEqual(
      boundaries.status,
      "CLEAN",
      "Multi-package workspace with 0 cross-package links must never report CLEAN"
    );
    assert.equal(boundaries.status, "ADVISORY");
    assert.equal(boundaries.summary.crossPackageLinkCount, 0);
    assert.equal(boundaries.summary.isolatedPackageCount, 2);
    assert.ok(
      boundaries.boundaryViolations.some(
        (v) => v.ruleId === "ISOLATED_DEPLOYMENT_UNITS" && v.severity === "ADVISORY"
      )
    );
    assert.ok(
      boundaries.seamDiagnostics.some((d) => d.kind === "ISOLATED_DEPLOYMENT_UNITS")
    );

    const health = auditGraphHealth(isolatedGraph);
    assert.ok(
      health.seamDiagnostics.some((d) => d.kind === "ISOLATED_DEPLOYMENT_UNITS")
    );
  });

  it("correlates unstitched client HTTP egress (parameterized fetch, axios baseURL, Next.js rewrites) against uncalled Express mounted routes across packages (UNSTITCHED_PROTOCOL_SEAM)", () => {
    const seamGraph: RepresentationGraph = {
      extractorVersion: "0.2.39",
      analyzedAt: "2026-11-03T00:00:00.000Z",
      nodes: [
        {
          id: "du-web",
          name: "Deployment Unit: @acme/web",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          metadata: {
            proxyRewrites: [
              {
                source: "/api/:path*",
                destination: "http://localhost:4000/api/:path*",
                configFilePath: "apps/web/next.config.ts",
              },
            ],
          },
          evidence: { filePath: "apps/web" },
        },
        {
          id: "du-server",
          name: "Deployment Unit: @acme/server",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "apps/server" },
        },
        {
          id: "fn-api-request",
          name: "Exported Function: apiRequest",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.exported-function",
          parentBoundaryId: "du-web",
          scope: "USER",
          evidence: { filePath: "apps/web/src/lib/api.ts", lineNumber: 8 },
        },
        {
          id: "oc-axios-create",
          name: "HTTP Call: axios.create",
          type: "OPEN_CONNECTOR",
          entityType: "HTTP_FETCH",
          patternId: "open-connector.http-call",
          parentBoundaryId: "du-web",
          scope: "USER",
          metadata: {
            receiver: "axios",
            method: "create",
            payload: ["{ baseURL: '/api' }"],
          },
          evidence: { filePath: "apps/web/src/lib/api.ts", lineNumber: 3 },
        },
        {
          id: "oc-fetch-wrapper",
          name: "HTTP Call: fetch('/api:param')",
          type: "OPEN_CONNECTOR",
          entityType: "HTTP_FETCH",
          patternId: "open-connector.http-call",
          parentBoundaryId: "du-web",
          scope: "USER",
          metadata: {
            method: "fetch",
            httpMethod: "ANY",
            urlPath: "/api:param",
            payload: ["`/api${endpoint}`", "options"],
          },
          evidence: { filePath: "apps/web/src/lib/api.ts", lineNumber: 12 },
        },
        {
          id: "init-server",
          name: "Init: @acme/server",
          type: "BOUNDARY",
          entityType: "INIT_BLOCK",
          patternId: "boundary.init-block",
          parentBoundaryId: "du-server",
          scope: "USER",
          evidence: { filePath: "apps/server/src/index.ts", lineNumber: 1 },
        },
        {
          id: "mod-users-router",
          name: "Module Export: usersRouter",
          type: "CONTRACT",
          entityType: "EXPORTED_MODULE",
          patternId: "contract.exported-module",
          parentBoundaryId: "du-server",
          scope: "USER",
          evidence: { filePath: "apps/server/src/routes/users.ts", lineNumber: 5 },
        },
        {
          id: "route-get-users",
          name: "Express Route: GET /users",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-server",
          scope: "USER",
          evidence: { filePath: "apps/server/src/routes/users.ts", lineNumber: 14 },
        },
        {
          id: "route-post-users",
          name: "Express Route: POST /users/:id",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-server",
          scope: "USER",
          evidence: { filePath: "apps/server/src/routes/users.ts", lineNumber: 28 },
        },
      ],
      edges: [
        {
          id: "e-call-fetch",
          name: "HTTP Request: fetch('/api:param')",
          type: "RELATIONSHIP",
          entityType: "HTTP_FETCH",
          patternId: "relationship.http-request",
          sourceId: "fn-api-request",
          targetId: "oc-fetch-wrapper",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "apps/web/src/lib/api.ts", lineNumber: 12 },
        },
        {
          id: "e-mount-users",
          name: "Express Mount: /api -> usersRouter",
          type: "RELATIONSHIP",
          entityType: "MOUNTS",
          patternId: "relationship.express-router-mount",
          sourceId: "init-server",
          targetId: "mod-users-router",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "apps/server/src/index.ts", lineNumber: 18 },
        },
      ],
    };

    const boundaries = checkGraphBoundaries(seamGraph);
    assert.equal(boundaries.status, "ADVISORY");
    assert.ok(boundaries.unstitchedProtocolSeams.length >= 1);

    const seam = boundaries.unstitchedProtocolSeams.find(
      (s) => s.clientConnector.id === "oc-fetch-wrapper"
    );
    assert.ok(seam, "Expected unstitched protocol seam for oc-fetch-wrapper");
    assert.equal(seam.clientPackage, "web");
    assert.equal(seam.serverPackage, "server");
    assert.equal(seam.clientCallers[0]?.id, "fn-api-request");
    assert.equal(seam.candidateServerRoutes.length, 2);
    assert.deepEqual(
      seam.candidateServerRoutes.map((r) => r.effectivePath).sort(),
      ["/api/users", "/api/users/:id"]
    );
    assert.equal(seam.candidateServerRoutes[0].mountPrefix, "/api");
    assert.ok(seam.detectedMechanisms.includes("parameterized-fetch-wrapper"));
    assert.ok(seam.detectedMechanisms.includes("axios-base-url"));
    assert.ok(seam.detectedMechanisms.includes("express-router-mount"));
    assert.ok(seam.detectedMechanisms.includes("nextjs-rewrite-proxy"));

    const health = auditGraphHealth(seamGraph);
    assert.equal(health.healthGate.unstitchedProtocolSeamCount, boundaries.unstitchedProtocolSeams.length);
    assert.ok(
      health.seamDiagnostics.some((d) => d.kind === "UNSTITCHED_PROTOCOL_SEAM")
    );

    // When a REQUESTS edge stitches the OPEN_CONNECTOR to the HTTP_ENDPOINT, the seam is resolved
    const stitchedGraph: RepresentationGraph = {
      ...seamGraph,
      edges: [
        ...seamGraph.edges,
        {
          id: "e-stitched-req",
          name: "HTTP Request: GET /api/users",
          type: "RELATIONSHIP",
          entityType: "REQUESTS",
          patternId: "relationship.http-route-binding",
          sourceId: "oc-fetch-wrapper",
          targetId: "route-get-users",
          status: "INFERRED",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "apps/web/src/lib/api.ts", lineNumber: 12 },
        },
      ],
    };

    const stitchedBoundaries = checkGraphBoundaries(stitchedGraph);
    assert.equal(
      stitchedBoundaries.unstitchedProtocolSeams.filter(
        (s) => s.clientConnector.id === "oc-fetch-wrapper"
      ).length,
      0,
      "Stitched HTTP_FETCH connector with outgoing REQUESTS edge must not be flagged as unstitched"
    );
  });

  it("flags INIT_BLOCK Gravity Leak when Init: <pkg> owns the majority of OPEN_CONNECTOR edges while HTTP_ENDPOINT / EXPORTED_MODULE contracts are dead-end ingress (INIT_BLOCK_CONNECTOR_LEAK)", () => {
    const leakGraph: RepresentationGraph = {
      extractorVersion: "0.2.39",
      analyzedAt: "2026-11-03T00:00:00.000Z",
      nodes: [
        {
          id: "du-api",
          name: "Deployment Unit: @acme/api",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "packages/api" },
        },
        {
          id: "init-api",
          name: "Init: @acme/api",
          type: "BOUNDARY",
          entityType: "INIT_BLOCK",
          patternId: "boundary.init-block",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "packages/api/src/routes/accounts.ts", lineNumber: 1 },
        },
        {
          id: "route-accounts",
          name: "Express Route: GET /api/accounts",
          type: "CONTRACT",
          entityType: "HTTP_ENDPOINT",
          patternId: "contract.express-route",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "packages/api/src/routes/accounts.ts", lineNumber: 10 },
        },
        {
          id: "mod-sync",
          name: "Module Export: accountSyncHandler",
          type: "CONTRACT",
          entityType: "EXPORTED_MODULE",
          patternId: "contract.exported-module",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "packages/api/src/services/sync.ts", lineNumber: 8 },
        },
        {
          id: "oc-db-query",
          name: "DB Call: db.query",
          type: "OPEN_CONNECTOR",
          entityType: "DB_QUERY",
          patternId: "open-connector.db-call",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: [
            { filePath: "packages/api/src/routes/accounts.ts", lineNumber: 16 },
            { filePath: "packages/api/src/services/sync.ts", lineNumber: 22 },
          ],
        },
        {
          id: "oc-http-fetch",
          name: "HTTP Call: fetch('https://billing.internal/sync')",
          type: "OPEN_CONNECTOR",
          entityType: "HTTP_FETCH",
          patternId: "open-connector.http-call",
          parentBoundaryId: "du-api",
          scope: "USER",
          evidence: { filePath: "packages/api/src/services/sync.ts", lineNumber: 29 },
        },
      ],
      edges: [
        {
          id: "e-init-db",
          name: "DB Query: db.query()",
          type: "RELATIONSHIP",
          entityType: "DB_QUERY",
          patternId: "relationship.db-query",
          sourceId: "init-api",
          targetId: "oc-db-query",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "packages/api/src/routes/accounts.ts", lineNumber: 16 },
        },
        {
          id: "e-init-http",
          name: "HTTP Request: fetch()",
          type: "RELATIONSHIP",
          entityType: "HTTP_FETCH",
          patternId: "relationship.http-request",
          sourceId: "init-api",
          targetId: "oc-http-fetch",
          status: "DETERMINISTIC",
          confidence: "HIGH",
          scope: "USER",
          evidence: { filePath: "packages/api/src/services/sync.ts", lineNumber: 29 },
        },
      ],
    };

    const health = auditGraphHealth(leakGraph);
    assert.equal(health.healthGate.initBlockConnectorLeakCount, 1);
    const leak = health.initBlockConnectorLeaks[0];
    assert.ok(leak);
    assert.equal(leak.kind, "INIT_BLOCK_CONNECTOR_LEAK");
    assert.equal(leak.packageName, "api");
    assert.equal(leak.initBlockNode.id, "init-api");
    assert.equal(leak.initConnectorEdgeCount, 2);
    assert.equal(leak.totalPackageConnectorEdgeCount, 2);
    assert.equal(leak.initConnectorSharePercent, 100);
    assert.equal(leak.deadEndContractCount, 2);
    assert.deepEqual(
      leak.affectedFiles,
      [
        "packages/api/src/services/sync.ts",
        "packages/api/src/routes/accounts.ts",
      ]
    );

    const boundaries = checkGraphBoundaries(leakGraph);
    assert.equal(boundaries.status, "ADVISORY");
    assert.equal(boundaries.summary.initBlockConnectorLeakCount, 1);
    assert.ok(
      boundaries.boundaryViolations.some(
        (v) => v.ruleId === "INIT_BLOCK_CONNECTOR_LEAK"
      )
    );
  });

  it("flags SHADOWED_DB_RECEPTOR when DB calls collapse into Package: pg micro-node with 0 DB_QUERY Open Connectors", () => {
    const shadowedDbGraph: RepresentationGraph = {
      extractorVersion: "1.1.0",
      analyzedAt: "2026-11-04T00:00:00.000Z",
      nodes: [
        {
          id: "du-server",
          name: "Deployment Unit: server",
          type: "BOUNDARY",
          entityType: "DEPLOYMENT_UNIT",
          patternId: "boundary.deployment-unit",
          scope: "USER",
          evidence: { filePath: "server/package.json" },
        },
        {
          id: "fn-db-query",
          name: "CJS Export: query",
          type: "CONTRACT",
          entityType: "EXPORTED_FUNCTION",
          patternId: "contract.commonjs-export",
          parentBoundaryId: "du-server",
          scope: "USER",
          evidence: { filePath: "server/src/db/dbconn.js", lineNumber: 11 },
        },
        {
          id: "pkg:pg",
          name: "Package: pg",
          type: "OPEN_CONNECTOR",
          entityType: "EXTERNAL_PACKAGE",
          patternId: "boundary.external-require",
          parentBoundaryId: "du-server",
          scope: "USER",
          evidence: { filePath: "server/src/db/dbconn.js", lineNumber: 1 },
        },
      ],
      edges: [
        {
          id: "e-query-pg",
          name: "Call: pool.query()",
          type: "RELATIONSHIP",
          entityType: "CALL",
          patternId: "relationship.invoke-returned-function",
          sourceId: "fn-db-query",
          targetId: "pkg:pg",
          status: "INFERRED",
          confidence: "LOW",
          scope: "USER",
          evidence: { filePath: "server/src/db/dbconn.js", lineNumber: 11 },
        },
      ],
    };

    const health = auditGraphHealth(shadowedDbGraph);
    const shadowedDiag = health.seamDiagnostics.find(
      (d) => d.kind === "SHADOWED_DB_RECEPTOR"
    );
    assert.ok(shadowedDiag, "Expected SHADOWED_DB_RECEPTOR in seamDiagnostics");
    if (shadowedDiag && shadowedDiag.kind === "SHADOWED_DB_RECEPTOR") {
      assert.equal(shadowedDiag.packageName, "server");
      assert.equal(shadowedDiag.expectedReceptorLabel, "Database: PostgreSQL");
      assert.equal(shadowedDiag.shadowedCallEdgeCount, 1);
    }

    const boundaries = checkGraphBoundaries(shadowedDbGraph);
    assert.equal(boundaries.status, "ADVISORY");
    assert.ok(
      boundaries.boundaryViolations.some(
        (v) => v.ruleId === "SHADOWED_DB_RECEPTOR"
      )
    );
  });

  it("withStorage guarantees storage.close() even when callback throws, loadActiveGraphCached caches by mtime, and withMcpToolErrorBoundary returns structured isError responses", async () => {
    let closeCalls = 0;
    let loadCalls = 0;
    const sampleGraph = createSampleGraph();
    const fakeStorageFactory = () =>
      ({
        getRepresentationGraph: async () => {
          loadCalls++;
          return sampleGraph;
        },
        close: async () => {
          closeCalls++;
        },
      }) as any;

    await assert.rejects(
      async () => {
        await withStorage(
          ":memory:",
          async () => {
            throw new Error("Simulated query failure");
          },
          fakeStorageFactory
        );
      },
      /Simulated query failure/
    );
    assert.equal(
      closeCalls,
      1,
      "withStorage must call storage.close() in finally even when callback throws"
    );

    // Test mtime-keyed graph caching against an existing committed file path
    const existingCommittedPath = resolve(import.meta.dirname, "index.ts");
    invalidateMcpGraphCache(existingCommittedPath);

    const first = await loadActiveGraphCached(
      existingCommittedPath,
      "sample-repo",
      fakeStorageFactory
    );
    assert.equal(first, sampleGraph);
    assert.equal(loadCalls, 1);
    assert.equal(closeCalls, 2);

    const second = await loadActiveGraphCached(
      existingCommittedPath,
      "sample-repo",
      fakeStorageFactory
    );
    assert.equal(second, sampleGraph);
    assert.equal(
      loadCalls,
      1,
      "Second loadActiveGraphCached call with unchanged mtime must hit in-memory cache"
    );
    assert.equal(closeCalls, 2);

    invalidateMcpGraphCache(existingCommittedPath);
    const third = await loadActiveGraphCached(
      existingCommittedPath,
      "sample-repo",
      fakeStorageFactory
    );
    assert.equal(third, sampleGraph);
    assert.equal(
      loadCalls,
      2,
      "After invalidateMcpGraphCache, loadActiveGraphCached must reload from storage"
    );
    assert.equal(closeCalls, 3);
    invalidateMcpGraphCache();

    // Test structured MCP tool error boundary
    const wrappedHandler = withMcpToolErrorBoundary(async () => {
      throw new Error("Chomp database not found at /nonexistent/.chomp/graph.db");
    });
    const errorResponse = await wrappedHandler({});
    assert.equal(errorResponse.isError, true);
    assert.equal(
      errorResponse.content?.[0]?.text,
      "Chomp database not found at /nonexistent/.chomp/graph.db"
    );
  });

  it("resolveViewTargetAltitude and buildActiveViewUrl select topological height and generate one-click deep-links ([PAT-MCP-03], [PAT-VIS-28])", () => {
    const graph = createSampleGraph();

    // Intra-package nodes -> defaults to "package" level with packageName="api"
    const singlePkg = resolveViewTargetAltitude(graph, ["route-orders", "fn-relay"]);
    assert.equal(singlePkg.viewLevel, "package");
    assert.equal(singlePkg.packageName, "api");
    assert.deepEqual(singlePkg.affectedPackages, ["api"]);
    assert.equal(
      buildActiveViewUrl({
        baseUrl: "http://localhost:5555",
        viewLevel: singlePkg.viewLevel,
        packageName: singlePkg.packageName,
      }),
      "http://localhost:5555/?view=active&level=package&pkg=api"
    );

    // Cross-package nodes (api + core) -> defaults to "system" level
    const multiPkg = resolveViewTargetAltitude(graph, ["route-orders", "fn-process"]);
    assert.equal(multiPkg.viewLevel, "system");
    assert.deepEqual(multiPkg.affectedPackages, ["api", "core"]);
    assert.equal(
      buildActiveViewUrl({
        baseUrl: "http://localhost:5555/",
        viewLevel: multiPkg.viewLevel,
        packageName: multiPkg.packageName,
      }),
      "http://localhost:5555/?view=active&level=system"
    );

    // Explicit viewLevel override is honored alongside scoped package names
    const explicitPkg = resolveViewTargetAltitude(
      graph,
      ["route-orders", "fn-process"],
      "package",
      "@chomp/core"
    );
    assert.equal(explicitPkg.viewLevel, "package");
    assert.equal(explicitPkg.packageName, "core");
    assert.equal(
      buildActiveViewUrl({
        baseUrl: "http://localhost:5555",
        viewLevel: "package",
        packageName: "@chomp/core",
      }),
      "http://localhost:5555/?view=active&level=package&pkg=@chomp/core"
    );

    // Git branch resolution works for git worktrees and standard repos
    const branch = resolveRepoGitBranch(resolve(import.meta.dirname, "../../.."), "main");
    assert.equal(typeof branch, "string");
    assert.ok(branch!.length > 0);
  });

  it("computeBlastRadius merges Speed 1 AST portValves with non-stale Speed 2 L1_PORTS overlays and surfaces caller port mismatches ([PAT-VIS-14])", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const graph = analyzeTarget(resolve(repoRoot, "fixtures/test-repos/port-valves"));
    const createOrderNode = graph.nodes.find((n) => n.name === "Exported Function: createOrder")!;
    const brokenNode = graph.nodes.find((n) => n.name === "Exported Function: submitBrokenOrder")!;

    // Speed 1 syntactic portValves work out-of-the-box with zero overlays
    const astBlast = computeBlastRadius(graph, { nodeId: createOrderNode.id });
    assert.equal(astBlast.found, true);
    assert.equal(astBlast.portValves.length, 1);
    assert.equal(astBlast.portValves[0].tier, "syntactic");
    assert.equal(astBlast.portValves[0].inputs?.[0]?.name, "input");
    assert.equal(astBlast.portValves[0].inputs?.[0]?.fields?.[0]?.name, "customerId");
    assert.equal(astBlast.portValves[0].output?.type, "OrderReceipt");
    assert.equal(astBlast.portValves[0].output?.async, true);

    // Speed 2 L1_PORTS overlays upgrade tier and surface incoming caller TS_CALL_MISMATCH diagnostics
    const verifiedBlast = computeBlastRadius(
      graph,
      { nodeId: createOrderNode.id },
      [
        {
          entityId: createOrderNode.id,
          layer: "L1_PORTS",
          source: "chomp-ports",
          stale: false,
          payload: {
            tier: "typechecked",
            origin: "ts-typecheck",
            inputs: astBlast.portValves[0].inputs,
            output: astBlast.portValves[0].output,
          },
        },
        {
          entityId: brokenNode.id,
          layer: "L1_PORTS",
          source: "chomp-ports",
          stale: false,
          payload: {
            tier: "typechecked",
            origin: "ts-typecheck",
            diagnostics: [
              {
                kind: "TS_CALL_MISMATCH",
                tsCode: 2345,
                message: "Property 'totalCents' is missing in type '{ customerId: string; }'",
                filePath: "orders.ts",
                lineNumber: 39,
                peerEntityId: createOrderNode.id,
              },
            ],
          },
        },
      ]
    );

    assert.equal(verifiedBlast.found, true);
    assert.equal(verifiedBlast.portValves[0].tier, "typechecked");
    assert.equal(verifiedBlast.summary?.portMismatchCount, 1);
    assert.ok(
      verifiedBlast.preEditGuidance.some((g) =>
        g.includes("Port Valve Mismatches (1)") && g.includes("submitBrokenOrder")
      )
    );
  });
});
