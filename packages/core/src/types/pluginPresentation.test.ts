import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLUGIN_PRESENTATION_LIMITS,
  PLUGIN_PRESENTATION_VERSION,
  capForPresentation,
  deferPresentationInPayload,
  payloadHasPresentation,
  readPresentationFromPayload,
  sanitizePluginPresentation,
} from "./pluginPresentation.js";

const valid = {
  version: 1,
  summary: {
    status: "warn",
    badge: { text: "79/100 (C)", tone: "warn" },
    issueCount: 380,
    metrics: [
      { id: "tokens", label: "Token adherence", value: 81, unit: "%" },
      { id: "adoption", label: "Atom adoption", value: null, hint: "no shared atoms" },
    ],
  },
  sections: [
    {
      id: "findings",
      title: "Findings",
      blocks: [
        {
          kind: "table",
          columns: [
            { id: "what", label: "What" },
            { id: "n", label: "Count", align: "right" },
          ],
          rows: [
            {
              cells: { what: "Hardcoded values", n: 380, ignored: "dropped" },
              evidence: [{ filePath: "a.css", lineNumber: 3, snippet: "color: #333" }],
            },
          ],
          totalCount: 380,
        },
      ],
    },
  ],
};

describe("Plugin presentation contract v1", () => {
  it("accepts a valid presentation, keeps honest nulls and total counts, and drops unknown cells", () => {
    const { presentation, warnings } = sanitizePluginPresentation(valid);
    assert.ok(presentation);
    assert.deepEqual(warnings, []);
    assert.equal(presentation.summary?.issueCount, 380);
    assert.equal(presentation.summary?.metrics?.[1]?.value, null, "null stays null (n/a), never becomes 0");
    const block = presentation.sections[0]!.blocks[0]!;
    assert.equal(block.kind, "table");
    if (block.kind === "table") {
      assert.deepEqual(Object.keys(block.rows[0]!.cells).sort(), ["n", "what"]);
      assert.equal(block.totalCount, 380);
      assert.equal(block.rows[0]!.evidence?.[0]?.lineNumber, 3);
    }
  });

  it("never throws on garbage and rejects unsupported versions", () => {
    for (const bad of [null, undefined, 42, "x", [], { version: 2, sections: [] }, { version: 1 }]) {
      const r = sanitizePluginPresentation(bad);
      assert.equal(r.presentation, null);
      assert.ok(r.warnings.length > 0);
    }
  });

  it("drops unknown block kinds (forward compatible), renames duplicate section ids, and orders by priority", () => {
    const { presentation, warnings } = sanitizePluginPresentation({
      version: 1,
      sections: [
        { id: "b", title: "B", priority: 200, blocks: [{ kind: "text", text: "hi" }] },
        { id: "a", title: "A", priority: 1, blocks: [{ kind: "hologram", data: 1 }, { kind: "text", text: "yo" }] },
        { id: "a", title: "A2", blocks: [{ kind: "text", text: "dup" }] },
        { title: "no id", blocks: [] },
      ],
    });
    assert.ok(presentation);
    assert.deepEqual(presentation.sections.map((s) => s.id), ["a", "a-2", "b"]);
    assert.equal(presentation.sections[0]!.blocks.length, 1);
    assert.ok(warnings.some((w) => w.includes("hologram")));
    assert.ok(warnings.some((w) => w.includes("duplicate section id")));
  });

  it("bounds sizes: sections, items, evidence, text, and HUD metrics", () => {
    const L = PLUGIN_PRESENTATION_LIMITS;
    const { presentation } = sanitizePluginPresentation({
      version: 1,
      summary: { metrics: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, label: `M${i}`, value: i })) },
      sections: Array.from({ length: 40 }, (_, i) => ({
        id: `s${i}`,
        title: "T".repeat(500),
        blocks: [
          {
            kind: "list",
            items: Array.from({ length: 500 }, (_, j) => ({
              label: "L".repeat(1000),
              evidence: Array.from({ length: 20 }, () => ({ filePath: "f.ts", snippet: "x".repeat(2000) })),
              ...(j === 0 ? {} : {}),
            })),
          },
          { kind: "text", text: "y".repeat(10000) },
        ],
      })),
    });
    assert.ok(presentation);
    assert.equal(presentation.summary?.metrics?.length, L.hudMetrics);
    assert.equal(presentation.sections.length, L.sections);
    assert.ok(presentation.sections[0]!.title.length <= L.title);
    const list = presentation.sections[0]!.blocks[0]!;
    assert.equal(list.kind, "list");
    if (list.kind === "list") {
      assert.equal(list.items.length, L.itemsPerBlock);
      assert.ok(list.items[0]!.label.length <= L.label);
      assert.equal(list.items[0]!.evidence?.length, L.evidencePerItem);
      assert.ok(list.items[0]!.evidence![0]!.snippet!.length <= L.snippet);
    }
    const text = presentation.sections[0]!.blocks[1]!;
    assert.ok(text.kind === "text" && text.text.length <= L.text);
  });

  it("payload helpers read and detect the presentation", () => {
    const payload = { score: 79, presentation: valid };
    assert.equal(payloadHasPresentation(payload), true);
    assert.equal(payloadHasPresentation({ score: 1 }), false);
    assert.ok(readPresentationFromPayload(payload));
    assert.equal(readPresentationFromPayload({ presentation: { version: 9 } }), null);
  });

  it("deferPresentationInPayload keeps other fields and marks the presentation as available", () => {
    const payload = { score: 79, presentation: valid };
    assert.deepEqual(deferPresentationInPayload(payload), { score: 79, presentationAvailable: true });
    const plain = { score: 1 };
    assert.equal(deferPresentationInPayload(plain), plain, "payloads without a presentation are returned as-is");
  });

  it("capForPresentation reports the pre-truncation total", () => {
    assert.deepEqual(capForPresentation([1, 2, 3, 4], 2), { items: [1, 2], totalCount: 4 });
  });

  it("sanitizes summary.views for plugin-driven active views", () => {
    const { presentation } = sanitizePluginPresentation({
      version: PLUGIN_PRESENTATION_VERSION,
      summary: {
        status: "warn",
        views: [
          {
            id: "arbitrary-tailwind",
            title: "One-off Tailwind values",
            description: "Components using bracketed Tailwind classes",
            badge: { text: "3", tone: "warn" },
            highlightNodeIds: ["contract:Button", "contract:Card", "contract:Button"],
            viewLevel: "package",
            packageName: "bite-size-web",
            nodeAnnotations: {
              "contract:Button": "2 arbitrary classes",
            },
            layer: "L1_DESIGN_SYSTEM",
          },
          {
            // Dropped: empty highlightNodeIds
            id: "empty-view",
            title: "Empty",
            highlightNodeIds: [],
          },
        ],
      },
      sections: [],
    });
    assert.ok(presentation?.summary?.views);
    assert.equal(presentation.summary.views.length, 1);
    const v = presentation.summary.views[0]!;
    assert.equal(v.id, "arbitrary-tailwind");
    assert.deepEqual(v.highlightNodeIds, ["contract:Button", "contract:Card"]);
    assert.equal(v.nodeAnnotations?.["contract:Button"], "2 arbitrary classes");
  });

  it("sanitizes metric card detail items and emptyText", () => {
    const { presentation } = sanitizePluginPresentation({
      version: PLUGIN_PRESENTATION_VERSION,
      sections: [
        {
          id: "design-system",
          title: "Design system",
          blocks: [
            {
              kind: "metrics",
              items: [
                {
                  id: "dryness",
                  label: "No duplicate UI",
                  value: 85,
                  unit: "%",
                  maxVisible: 6,
                  totalCount: 2,
                  emptyText: "No duplicates",
                  items: [
                    { label: "MetricCard, StatCard", detail: "Similar Card", entityId: "c1" },
                    { label: "CardHeader", detail: "Repeats 3× in Dashboard" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const block = presentation?.sections[0]?.blocks[0];
    assert.equal(block?.kind, "metrics");
    if (block?.kind === "metrics") {
      assert.equal(block.items[0]?.items?.length, 2);
      assert.equal(block.items[0]?.items?.[0]?.label, "MetricCard, StatCard");
      assert.equal(block.items[0]?.items?.[0]?.detail, "Similar Card");
      assert.equal(block.items[0]?.maxVisible, 6);
      assert.equal(block.items[0]?.emptyText, "No duplicates");
    }
  });
});
