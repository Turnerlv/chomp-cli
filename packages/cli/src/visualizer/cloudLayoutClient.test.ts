import test from "node:test";
import assert from "node:assert/strict";
import type { RepresentationGraph } from "@chomp/core";
import {
  anonymizeGraphForCloudLayout,
  rehydrateCloudLayout,
  stripEvidenceSnippetsFromGraph,
} from "./cloudLayoutClient.js";
import { loadLocalMasterLayoutEngine } from "./localEngineBridge.js";

const {
  executeStatelessLayout,
  runGridMapper,
  runStoryTracer,
  runZipMerge,
} = await loadLocalMasterLayoutEngine();

function buildFixtureGraph(): RepresentationGraph {
  return {
    repoId: "acme-secret-monorepo",
    version: "1.1.0",
    extractedAt: "2026-01-01T00:00:00.000Z",
    nodes: [
      {
        id: "pkg_billing_01",
        name: "Deployment Unit: @acme/secret-billing",
        type: "BOUNDARY",
        entityType: "DEPLOYMENT_UNIT",
        patternId: "boundary.deployment-unit",
        scope: "USER",
        evidence: {
          filePath: "packages/secret-billing/package.json",
          lineNumber: 1,
          snippet: '{ "name": "@acme/secret-billing", "private": true }',
        },
      },
      {
        id: "route_checkout_01",
        name: "HTTP Endpoint: POST /api/checkout",
        type: "CONTRACT",
        entityType: "HTTP_ENDPOINT",
        patternId: "contract.express-route",
        parentBoundaryId: "pkg_billing_01",
        scope: "USER",
        metadata: {
          flowRole: "INGRESS",
        },
        evidence: [
          {
            filePath: "packages/secret-billing/src/routes/checkoutRoutes.ts",
            lineNumber: 14,
            snippet: 'router.post("/api/checkout", requireCustomerAuth, handleOrderCheckout);',
          },
        ],
      },
      {
        id: "mw_auth_01",
        name: "Middleware: requireCustomerAuth",
        type: "CONTRACT",
        entityType: "MIDDLEWARE",
        patternId: "contract.express-middleware",
        parentBoundaryId: "pkg_billing_01",
        scope: "USER",
        evidence: [
          {
            filePath: "packages/secret-billing/src/middleware/customerAuth.ts",
            lineNumber: 8,
            snippet: "export function requireCustomerAuth(req, res, next) { verifyJwt(req.headers.authorization); }",
          },
        ],
      },
      {
        id: "fn_handle_checkout_01",
        name: "Exported Function: processSecretCheckoutOrder",
        type: "CONTRACT",
        entityType: "EXPORTED_FUNCTION",
        patternId: "contract.exported-function",
        parentBoundaryId: "pkg_billing_01",
        scope: "USER",
        metadata: {
          inputTypes: ["SecretOrderRequest"],
          outputType: "Promise<SecretReceipt>",
          portValves: {
            tier: "syntactic",
            origin: "ts-signature",
            inputs: [
              {
                name: "secretOrder",
                type: "SecretOrderRequest",
                fields: [{ name: "secretCardToken", type: "string" }],
              },
            ],
            output: {
              type: "SecretReceipt",
              async: true,
            },
          },
        },
        evidence: [
          {
            filePath: "packages/secret-billing/src/services/orderCheckout.ts",
            lineNumber: 42,
            snippet: "export async function processSecretCheckoutOrder(payload: SecretOrderRequest) {",
          },
        ],
      },
      {
        id: "fn_util_format_01",
        name: "Exported Function: formatSecretCurrencyCents",
        type: "CONTRACT",
        entityType: "EXPORTED_FUNCTION",
        patternId: "contract.exported-function",
        parentBoundaryId: "pkg_billing_01",
        scope: "USER",
        evidence: [
          {
            filePath: "packages/secret-billing/src/utils/currencyFormat.ts",
            lineNumber: 5,
            snippet: "export function formatSecretCurrencyCents(amount: number) { return `$${(amount / 100).toFixed(2)}`; }",
          },
        ],
      },
      {
        id: "oc_http_stripe_01",
        name: "HTTP Call: https://vault.internal.acme.corp/v1/charges",
        type: "OPEN_CONNECTOR",
        entityType: "EXTERNAL_HTTP_CALL",
        patternId: "connector.fetch-call",
        parentBoundaryId: "pkg_billing_01",
        scope: "USER",
        evidence: [
          {
            filePath: "packages/secret-billing/src/services/orderCheckout.ts",
            lineNumber: 68,
            snippet: 'await fetch("https://vault.internal.acme.corp/v1/charges", { method: "POST" });',
          },
        ],
      },
    ],
    edges: [
      {
        id: "e_route_mw",
        sourceId: "route_checkout_01",
        targetId: "mw_auth_01",
        name: "intercepts",
        type: "RELATIONSHIP",
        entityType: "INTERCEPTS",
        patternId: "relationship.express-middleware-bind",
        scope: "USER",
        evidence: { filePath: "packages/secret-billing/src/routes/checkoutRoutes.ts", lineNumber: 14 },
      },
      {
        id: "e_route_handler",
        sourceId: "route_checkout_01",
        targetId: "fn_handle_checkout_01",
        name: "calls",
        type: "RELATIONSHIP",
        entityType: "CALL",
        patternId: "relationship.express-route-bind",
        scope: "USER",
        evidence: { filePath: "packages/secret-billing/src/routes/checkoutRoutes.ts", lineNumber: 14 },
      },
      {
        id: "e_handler_util",
        sourceId: "fn_handle_checkout_01",
        targetId: "fn_util_format_01",
        name: "calls",
        type: "RELATIONSHIP",
        entityType: "CALL",
        patternId: "relationship.function-call",
        scope: "USER",
        evidence: { filePath: "packages/secret-billing/src/services/orderCheckout.ts", lineNumber: 50 },
      },
      {
        id: "e_handler_http",
        sourceId: "fn_handle_checkout_01",
        targetId: "oc_http_stripe_01",
        name: "calls",
        type: "RELATIONSHIP",
        entityType: "HTTP_FETCH",
        patternId: "relationship.http-fetch",
        scope: "USER",
        evidence: { filePath: "packages/secret-billing/src/services/orderCheckout.ts", lineNumber: 68 },
      },
    ],
  } as unknown as RepresentationGraph;
}

test("anonymizeGraphForCloudLayout scrubs all business identifiers, file paths, and code snippets", () => {
  const graph = buildFixtureGraph();
  const { request } = anonymizeGraphForCloudLayout(graph);
  const serialized = JSON.stringify(request);

  // Sensitive identifiers, hostnames, paths, and snippets must NEVER appear in the wire payload
  assert.equal(serialized.includes("acme-secret-monorepo"), false);
  assert.equal(serialized.includes("secret-billing"), false);
  assert.equal(serialized.includes("processSecretCheckoutOrder"), false);
  assert.equal(serialized.includes("requireCustomerAuth"), false);
  assert.equal(serialized.includes("formatSecretCurrencyCents"), false);
  assert.equal(serialized.includes("vault.internal.acme.corp"), false);
  assert.equal(serialized.includes("orderCheckout.ts"), false);
  assert.equal(serialized.includes("customerAuth.ts"), false);
  assert.equal(serialized.includes("verifyJwt"), false);
  assert.equal(serialized.includes("SecretOrderRequest"), false);
  assert.equal(serialized.includes("snippet"), false);
});

test("stateless skeleton round-trip produces identical coordinates and restores real labels & snippet-free evidence", () => {
  const graph = buildFixtureGraph();

  // Direct local pipeline execution
  const sanitizedGraph = stripEvidenceSnippetsFromGraph(graph);
  const localStoryGraph = runStoryTracer(sanitizedGraph);
  const localMerged = runZipMerge(localStoryGraph);
  const localLayout = runGridMapper(localMerged);

  // Stateless Cloud Worker round-trip
  const { request, hydrationMap } = anonymizeGraphForCloudLayout(graph);
  const workerResponse = executeStatelessLayout(request);
  const hydratedLayout = rehydrateCloudLayout(
    workerResponse,
    hydrationMap,
    graph,
    "acme-secret-monorepo",
  );

  assert.equal(hydratedLayout.nodes.length, localLayout.nodes.length);
  assert.equal(hydratedLayout.edges.length, localLayout.edges.length);

  for (let i = 0; i < localLayout.nodes.length; i++) {
    const localNode = localLayout.nodes[i];
    const cloudNode = hydratedLayout.nodes[i];
    assert.equal(cloudNode.id, localNode.id);
    assert.equal(cloudNode.label, localNode.label);
    assert.equal(cloudNode.role, localNode.role);
    assert.equal(cloudNode.x, localNode.x);
    assert.equal(cloudNode.y, localNode.y);
    assert.equal(cloudNode.width, localNode.width);
    assert.equal(cloudNode.height, localNode.height);
    assert.deepEqual(cloudNode.badges, localNode.badges);

    // Verify evidence has filePath and lineNumber but NO snippet
    if (cloudNode.evidence && cloudNode.evidence.length > 0) {
      assert.equal(typeof cloudNode.evidence[0].filePath, "string");
      assert.equal("snippet" in cloudNode.evidence[0], false);
    }
  }
});

test("Cloudflare Worker fetch handler serves stateless /health and /v1/layout with no-store headers", async () => {
  const workerModuleUrl = new URL(
    "../../../../apps/cloud-layout-worker/src/index.ts",
    import.meta.url,
  ).href;
  const { default: workerHandler } = (await import(workerModuleUrl)) as {
    default: { fetch: (req: Request, env: Record<string, unknown>) => Promise<Response> };
  };
  const healthReq = new Request("https://api.getchomp.dev/health", {
    method: "GET",
  });
  const healthRes = await workerHandler.fetch(healthReq, {});
  assert.equal(healthRes.status, 200);
  const healthJson = (await healthRes.json()) as Record<string, unknown>;
  assert.equal(healthJson.status, "ok");
  assert.equal(healthJson.persistence, "none");

  const graph = buildFixtureGraph();
  const { request, hydrationMap } = anonymizeGraphForCloudLayout(graph);

  const layoutReq = new Request("https://api.getchomp.dev/v1/layout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const layoutRes = await workerHandler.fetch(layoutReq, {});
  assert.equal(layoutRes.status, 200);
  assert.match(layoutRes.headers.get("Cache-Control") ?? "", /no-store/);

  const body = await layoutRes.json();
  const hydrated = rehydrateCloudLayout(
    body as any,
    hydrationMap,
    graph,
    "acme-secret-monorepo",
  );
  const checkoutNode = hydrated.nodes.find((n) =>
    n.label.includes("processSecretCheckoutOrder"),
  );
  assert.ok(checkoutNode, "Expected hydrated layout to contain processSecretCheckoutOrder");
  assert.equal(
    checkoutNode.evidence?.[0]?.filePath,
    "packages/secret-billing/src/services/orderCheckout.ts",
  );
  assert.equal(checkoutNode.evidence?.[0]?.lineNumber, 42);
  assert.equal(checkoutNode.evidence?.[0]?.snippet, undefined);
  assert.equal(
    JSON.stringify(request).includes("secretCardToken"),
    false,
    "Cloud layout request must never transmit proprietary portValves field names",
  );
  assert.equal(
    checkoutNode.portValves?.inputs?.[0]?.fields?.[0]?.name,
    "secretCardToken",
    "Local rehydration must restore portValves onto LayoutNode",
  );
});
