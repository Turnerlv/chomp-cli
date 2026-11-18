/**
 * packages/cli/src/visualizer/localEngineBridge.ts
 *
 * Master Monorepo vs. Published NPM Bridge (`W2.0a` / `STRATEGY_AND_PACKAGING.md` §2).
 *
 * - Inside the private master monorepo (when `apps/cloud-layout-worker/src/pipeline-topo` exists on disk
 *   and `CHOMP_DISABLE_LOCAL_LAYOUT_ENGINE` is not set), dynamically loads the proprietary layout engine
 *   in-process with zero network calls and `tier: "master"` entitlement.
 * - In published `@chomp/cli` NPM installs, `apps/cloud-layout-worker` is absent from disk, so the CLI
 *   defaults to `https://api.getchomp.dev` and `https://app.getchomp.dev?port=<port>`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphDelta, RepresentationGraph } from "@chomp/core";
import { getChompMasterRoot } from "../utils/masterContext.js";
import type {
  StatelessLayoutRequest,
  StatelessLayoutResponse,
} from "./cloudLayoutClient.js";
import type { ChompRulesConfig } from "./rulesConfig.js";
import type {
  EntityOverlayItem,
  LayoutData,
  LayoutNode,
  WorkingNode,
} from "./types.js";

export const DEFAULT_CLOUD_API_URL = "https://api.getchomp.dev";
export const DEFAULT_HOSTED_UI_URL = "https://app.getchomp.dev";

export interface StoryTraceResultShape {
  stories: Array<{
    storyIndex: number;
    entryId: string;
    entryLabel: string;
    packageLabel: string;
    nodes: Array<WorkingNode & { originalId: string; columnIndex: number; [k: string]: any }>;
    [k: string]: any;
  }>;
  orphanNodes: WorkingNode[];
  foldedMasterNodes?: WorkingNode[];
  totalRawNodeCount: number;
  [k: string]: any;
}

export interface MergedStoryGraphShape extends StoryTraceResultShape {
  anchorCount: number;
  badgedCount: number;
}

export interface LocalMasterPipelineModule {
  runStoryTracer: (
    rawGraph: RepresentationGraph,
    diffDelta?: GraphDelta,
    rulesConfig?: ChompRulesConfig,
    overlays?: EntityOverlayItem[],
  ) => StoryTraceResultShape;
  runZipMerge: (storyGraph: StoryTraceResultShape) => MergedStoryGraphShape;
  runGridMapper: (
    mergedGraph: MergedStoryGraphShape,
    rulesConfig?: ChompRulesConfig,
  ) => LayoutData;
  isSemanticUtilityLabel: (
    label: string,
    outDegree?: number,
    foldedCount?: number,
  ) => boolean;
  writeMatrixCsv: (graph: MergedStoryGraphShape, cwd?: string) => void;
  writeLayoutCsv: (layoutData: LayoutData, cwd?: string) => void;
  buildPureLibraryFallbackBoard: (...args: any[]) => any;
  estimateNodeVisualHeight: (node: Partial<LayoutNode> | any) => number;
  executeStatelessLayout: (
    request: StatelessLayoutRequest,
  ) => StatelessLayoutResponse;
}

function resolveLocalMasterEnginePath(): string | null {
  if (process.env.CHOMP_DISABLE_LOCAL_LAYOUT_ENGINE === "1") {
    return null;
  }
  const masterRoot = getChompMasterRoot();
  const candidates = [
    resolve(masterRoot, "apps/cloud-layout-worker/src/pipeline-topo/index.ts"),
    resolve(masterRoot, "apps/cloud-layout-worker/src/pipeline-topo/index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function hasLocalMasterLayoutEngine(): boolean {
  return resolveLocalMasterEnginePath() !== null;
}

export function resolveLocalMasterWebDir(): string | null {
  if (process.env.CHOMP_DISABLE_LOCAL_LAYOUT_ENGINE === "1") {
    return null;
  }
  const masterRoot = getChompMasterRoot();
  const webOutDir = resolve(masterRoot, "apps/web/out");
  if (existsSync(resolve(webOutDir, "index.html"))) {
    return webOutDir;
  }
  return null;
}

let cachedEnginePromise: Promise<LocalMasterPipelineModule> | null = null;

export async function loadLocalMasterLayoutEngine(): Promise<LocalMasterPipelineModule> {
  const enginePath = resolveLocalMasterEnginePath();
  if (!enginePath) {
    throw new Error(
      "Local master layout engine is not present in this installation. Connect to https://api.getchomp.dev instead.",
    );
  }
  if (!cachedEnginePromise) {
    const fileHref = pathToFileURL(enginePath).href;
    // Variable dynamic import prevents bundlers and npm pack from tracing into apps/cloud-layout-worker
    cachedEnginePromise = import(fileHref) as Promise<LocalMasterPipelineModule>;
  }
  return cachedEnginePromise;
}
