import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { analyzeTarget } from "@chomp/core";
import { createSQLiteStorage } from "@chomp/db";
import { getChompMasterRoot } from "../utils/masterContext.js";
import { auditLayoutGeometry, validateLayoutPayload } from "../utils/visualLinter.js";
import { loadLocalMasterLayoutEngine } from "./localEngineBridge.js";

const { runGridMapper, runStoryTracer, runZipMerge } =
  await loadLocalMasterLayoutEngine();

describe("validateLayoutPayload and auditLayoutGeometry 2D spatial verification", () => {
  it("catches overlapping station cards, multi-line badge overflow collisions, package bounds leaks, macro cell collisions, NaN coords, and wire-through-card crossings", () => {
    // 1. Overlapping station cards (including dynamic height expansion via badges + 2-line label)
    const overlappingPayload = {
      nodes: [
        {
          id: "api::routeA::row0",
          label: "Express Route: POST /api/v1/organizations/memberships/invite",
          entityType: "HTTP_ENDPOINT",
          isPackage: false,
          packageLabel: "api",
          role: "INGRESS",
          badges: ["Middleware: requireAuth", "Middleware: rateLimiter", "Middleware: csrfCheck"],
          x: 40,
          y: 40,
          width: 240,
          height: 36, // understated height: estimateNodeVisualHeight expands > 60px into row1 at y=84
        },
        {
          id: "api::routeB::row1",
          label: "Express Route: GET /health",
          entityType: "HTTP_ENDPOINT",
          isPackage: false,
          packageLabel: "api",
          role: "INGRESS_RETURN",
          badges: [],
          x: 40,
          y: 84,
          width: 240,
          height: 36,
        },
      ],
      edges: [],
      packageBounds: {
        api: { minX: 0, minY: 0, maxX: 320, maxY: 220, macroCol: 0, macroRow: 0 },
      },
    };

    const overlapGeom = auditLayoutGeometry(overlappingPayload);
    assert.equal(overlapGeom.passed, false);
    assert.equal(overlapGeom.stationOverlaps.length, 1);
    const overlapErrors = validateLayoutPayload(overlappingPayload);
    assert.ok(
      overlapErrors.some((e) => e.includes("Overlapping station cards")),
      `Expected overlapping station card error, got: ${overlapErrors.join("; ")}`,
    );
    // Notice routeB has role === "INGRESS_RETURN" and 0 outgoing edges -> MUST NOT be flagged as Dead-End Ingress!
    assert.ok(
      !overlapErrors.some((e) => e.includes("Dead-End Ingress") && e.includes("GET /health")),
      "Self-contained INGRESS_RETURN endpoint must not be flagged as Dead-End Ingress ([PAT-VIS-35])",
    );

    // 2. Package bounds leak + Macro Grid cell collision + NaN routing coordinate + intra-package wire cutting through card
    const brokenSpatialPayload = {
      nodes: [
        {
          id: "web::pageHome::row0",
          label: "Next.js Page: /",
          entityType: "NEXTJS_PAGE",
          isPackage: false,
          packageLabel: "web",
          role: "INGRESS",
          x: 40,
          y: 40,
          width: 240,
          height: 36,
        },
        {
          id: "web::blockerMid::row0",
          label: "Unrelated Station",
          entityType: "EXPORTED_FUNCTION",
          isPackage: false,
          packageLabel: "web",
          role: "RETURN",
          x: 340,
          y: 30,
          width: 240,
          height: 56,
        },
        {
          id: "web::apiCall::row0",
          label: "HTTP Call: fetch /api/items",
          entityType: "HTTP_FETCH",
          isPackage: false,
          packageLabel: "web",
          role: "EGRESS",
          x: 700, // leaks past web.maxX (640)
          y: 40,
          width: 240,
          height: 36,
        },
        {
          id: "nanNode",
          label: "Broken Coord",
          entityType: "EXPORTED_FUNCTION",
          isPackage: false,
          packageLabel: "api",
          role: "RETURN",
          x: Number.NaN,
          y: 100,
          width: 240,
          height: 36,
        },
      ],
      edges: [
        {
          id: "e-wire-through-blocker",
          sourceId: "web::pageHome::row0",
          targetId: "web::apiCall::row0",
          sections: [
            {
              startPoint: { x: 280, y: 58 },
              bendPoints: [],
              endPoint: { x: 700, y: 58 }, // straight line y=58 cuts across blockerMid [340..580, 30..86]
            },
          ],
        },
      ],
      packageBounds: {
        web: { minX: 0, minY: 0, maxX: 640, maxY: 200, macroCol: 0, macroRow: 0 },
        api: { minX: 900, minY: 0, maxX: 1300, maxY: 200, macroCol: 0, macroRow: 0 }, // collides on macro cell (0, 0)
      },
    };

    const spatialGeom = auditLayoutGeometry(brokenSpatialPayload);
    assert.equal(spatialGeom.passed, false);
    assert.equal(spatialGeom.packageBoundsLeaks.length, 1);
    assert.equal(spatialGeom.macroPackageOverlaps.length, 1);
    assert.equal(spatialGeom.macroPackageOverlaps[0]?.reason, "MACRO_CELL_COLLISION");
    assert.equal(spatialGeom.nonFiniteItems.length, 1);
    assert.equal(spatialGeom.wireCollisions.length, 1);
    assert.equal(spatialGeom.wireCollisions[0]?.blockerId, "web::blockerMid::row0");
  });

  it("verifies zero 2D spatial/geometric overlaps or leaks across 10 diverse test-repo fixtures and Chomp's self-graph", async () => {
    const masterRoot = getChompMasterRoot();
    const fixtureNames = [
      "express-app",
      "fullstack-monolith-decomposition",
      "layered-app",
      "mcp-tool-ownership",
      "monolith-domains",
      "monorepo-pnpm",
      "multi-shape-workspaces",
      "nextjs-app-router",
      "nextjs-drizzle",
      "nodebb-socket",
    ];

    for (const fixtureName of fixtureNames) {
      const fixtureDir = resolve(masterRoot, "fixtures/test-repos", fixtureName);
      assert.ok(existsSync(fixtureDir), `Fixture missing: ${fixtureDir}`);
      const graph = analyzeTarget(fixtureDir);
      const traced = runStoryTracer(graph);
      const merged = runZipMerge(traced);
      const layout = runGridMapper(merged);
      const geom = auditLayoutGeometry(layout);

      assert.equal(
        geom.passed,
        true,
        `Fixture "${fixtureName}" failed 2D geometry audit: overlaps=${JSON.stringify(geom.stationOverlaps)}, leaks=${JSON.stringify(geom.packageBoundsLeaks)}, macroOverlaps=${JSON.stringify(geom.macroPackageOverlaps)}, nonFinite=${JSON.stringify(geom.nonFiniteItems)}`,
      );
    }

    // Also verify Chomp's persisted self-graph (.chomp/graph.db) if present
    const selfDbPath = resolve(masterRoot, ".chomp", "graph.db");
    if (existsSync(selfDbPath)) {
      const storage = createSQLiteStorage(selfDbPath);
      try {
        const repos = await storage.listRepositories();
        const selfRepo = repos.find((r) => r.name === "chomp") ?? repos[0];
        if (selfRepo) {
          const selfGraph = await storage.getRepresentationGraph(selfRepo.id);
          if (selfGraph) {
            const selfLayout = runGridMapper(runZipMerge(runStoryTracer(selfGraph)));
            const selfGeom = auditLayoutGeometry(selfLayout);
            assert.equal(
              selfGeom.passed,
              true,
              `Chomp self-layout failed 2D geometry audit: overlaps=${JSON.stringify(selfGeom.stationOverlaps)}, leaks=${JSON.stringify(selfGeom.packageBoundsLeaks)}, macroOverlaps=${JSON.stringify(selfGeom.macroPackageOverlaps)}`,
            );
          }
        }
      } finally {
        await storage.close();
      }
    }
  });
});
