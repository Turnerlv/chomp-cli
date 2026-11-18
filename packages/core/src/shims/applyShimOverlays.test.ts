import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyShimOverlaysToGraph, SHIM_OVERLAY_LAYER } from "./applyShimOverlays.js";
import type { RepresentationGraph } from "../types/ontology.js";

function makeBaseGraph(): RepresentationGraph {
  return {
    extractorVersion: "0.1.0",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      {
        id: "du-api",
        name: "Deployment Unit: api",
        type: "BOUNDARY",
        entityType: "DEPLOYMENT_UNIT",
        patternId: "boundary.deployment-unit",
        scope: "USER",
        evidence: { filePath: "package.json" },
      },
      {
        id: "fn-checkout",
        name: "Exported Function: checkout",
        type: "CONTRACT",
        entityType: "EXPORTED_FUNCTION",
        patternId: "contract.exported-function",
        parentBoundaryId: "du-api",
        scope: "USER",
        evidence: { filePath: "src/checkout.ts", lineNumber: 10 },
      },
      {
        id: "fn-charge",
        name: "Exported Function: chargeCard",
        type: "CONTRACT",
        entityType: "EXPORTED_FUNCTION",
        patternId: "contract.exported-function",
        parentBoundaryId: "du-api",
        scope: "USER",
        evidence: { filePath: "src/payments.ts", lineNumber: 4 },
      },
    ],
    edges: [
      {
        id: "edge-unresolved-1",
        name: "Call: container.resolve()",
        type: "RELATIONSHIP",
        entityType: "CALL",
        patternId: "relationship.function-call",
        scope: "USER",
        sourceId: "fn-checkout",
        status: "DETERMINISTIC",
        confidence: "LOW",
        evidence: { filePath: "src/checkout.ts", lineNumber: 12 },
        metadata: { shapeKey: "sk1/CALL/LocalVar/PropertyAccessExpression" },
      },
    ],
  };
}

describe("applyShimOverlaysToGraph", () => {
  it("resolves matched unresolved Layer 0 edges in memory without mutating the input graph", () => {
    const base = makeBaseGraph();
    const overlays = [
      {
        entityId: "fn-checkout",
        layer: SHIM_OVERLAY_LAYER,
        payload: {
          shimmedEdges: [
            {
              shimId: "shim-checkout-charge",
              sourceId: "fn-checkout",
              targetId: "fn-charge",
              name: "Call: chargeCard()",
              entityType: "CALL",
              resolvedEdgeIds: ["edge-unresolved-1"],
              rationale: "Runtime DI container resolves PaymentProvider to chargeCard",
              evidence: { filePath: "src/checkout.ts", lineNumber: 12 },
            },
          ],
        },
      },
    ];

    const projected = applyShimOverlaysToGraph(base, overlays);
    assert.equal(base.edges[0]?.targetId, undefined, "base Layer 0 graph must remain untouched");
    assert.equal(projected.edges.length, 1);
    assert.equal(projected.edges[0]?.targetId, "fn-charge");
    assert.equal(projected.edges[0]?.status, "INFERRED");
    assert.equal(projected.edges[0]?.confidence, "HIGH");
    assert.equal(projected.edges[0]?.metadata?.source, "USER_SHIM");
    assert.equal(projected.edges[0]?.metadata?.shimId, "shim-checkout-charge");
  });

  it("supports synthetic open connectors and bypasses projection when enabled is false", () => {
    const base = makeBaseGraph();
    const overlays = [
      {
        entityId: "fn-checkout",
        layer: SHIM_OVERLAY_LAYER,
        payload: {
          syntheticConnectors: [
            {
              id: "conn-stripe",
              name: "HTTP Call: POST https://api.stripe.com/v1/charges",
              type: "OPEN_CONNECTOR",
              entityType: "HTTP_FETCH",
              patternId: "shim.open-connector",
              evidence: { filePath: "src/checkout.ts", lineNumber: 15 },
            },
          ],
          shimmedEdges: [
            {
              shimId: "shim-stripe-http",
              sourceId: "fn-checkout",
              targetId: "conn-stripe",
              name: "Call: HTTP Call: POST https://api.stripe.com/v1/charges",
              entityType: "CALL",
              evidence: { filePath: "src/checkout.ts", lineNumber: 15 },
            },
          ],
        },
      },
    ];

    const disabled = applyShimOverlaysToGraph(base, overlays, { enabled: false });
    assert.strictEqual(disabled, base);

    const enabled = applyShimOverlaysToGraph(base, overlays, { enabled: true });
    assert.ok(enabled.nodes.some((n) => n.id === "conn-stripe" && n.type === "OPEN_CONNECTOR"));
    assert.ok(
      enabled.edges.some(
        (e) =>
          e.sourceId === "fn-checkout" &&
          e.targetId === "conn-stripe" &&
          e.status === "INFERRED" &&
          e.metadata?.source === "USER_SHIM",
      ),
    );
  });
});
