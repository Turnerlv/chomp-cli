/**
 * @fileoverview Two-Speed Core Structure Port Valve merge & sanitization helpers (`[PAT-VIS-14]`, `[PAT-EXT-22]`).
 *
 * Re-exports canonical Port Valve interfaces from `./ontology.js` and provides {@link mergeContractPortValves}
 * for combining Speed 1 AST `node.metadata.portValves` with Speed 2 `L1_PORTS` `entity_overlays` rows.
 */

import type {
  ContractPortValves,
  PortDeclarationRef,
  PortDiagnostic,
  PortFieldSchema,
  PortOutputValve,
  PortParameterValve,
  PortSchemaOrigin,
  PortVerificationTier,
} from './ontology.js';

export type {
  ContractPortValves,
  PortDeclarationRef,
  PortDiagnostic,
  PortFieldSchema,
  PortOutputValve,
  PortParameterValve,
  PortSchemaOrigin,
  PortVerificationTier,
};

/**
 * Minimal overlay item shape consumed when merging persisted `L1_PORTS` rows onto Speed 1 AST valves.
 */
export interface PortOverlayLike {
  layer?: string;
  source?: string;
  stale?: boolean;
  payload?: Record<string, any> | null;
}

const TIER_RANK: Record<PortVerificationTier, number> = {
  syntactic: 1,
  typechecked: 2,
  spec: 3,
};

function sanitizeFieldList(raw: unknown): PortFieldSchema[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: PortFieldSchema[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name.trim()) continue;
    const typeStr = typeof rec.type === 'string' && rec.type.trim() ? rec.type.trim() : 'unknown';
    const nested = sanitizeFieldList(rec.fields);
    out.push({
      name: rec.name.trim(),
      type: typeStr,
      ...(rec.optional === true ? { optional: true } : {}),
      ...(nested ? { fields: nested } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeDeclaration(raw: unknown): PortDeclarationRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.filePath !== 'string' || !rec.filePath.trim()) return undefined;
  return {
    filePath: rec.filePath.trim(),
    ...(typeof rec.lineNumber === 'number' && rec.lineNumber > 0
      ? { lineNumber: rec.lineNumber }
      : {}),
  };
}

function sanitizeInputs(raw: unknown): PortParameterValve[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: PortParameterValve[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name.trim()) continue;
    const typeStr = typeof rec.type === 'string' && rec.type.trim() ? rec.type.trim() : 'unknown';
    const fields = sanitizeFieldList(rec.fields);
    const declaration = sanitizeDeclaration(rec.declaration);
    out.push({
      name: rec.name.trim(),
      type: typeStr,
      ...(rec.optional === true ? { optional: true } : {}),
      ...(fields ? { fields } : {}),
      ...(declaration ? { declaration } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeOutput(raw: unknown): PortOutputValve | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.type !== 'string' || !rec.type.trim()) return undefined;
  const fields = sanitizeFieldList(rec.fields);
  const declaration = sanitizeDeclaration(rec.declaration);
  return {
    type: rec.type.trim(),
    ...(rec.async === true ? { async: true } : {}),
    ...(fields ? { fields } : {}),
    ...(declaration ? { declaration } : {}),
  };
}

function sanitizeDiagnostics(raw: unknown): PortDiagnostic[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: PortDiagnostic[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.message !== 'string' || !rec.message.trim()) continue;
    if (typeof rec.filePath !== 'string' || !rec.filePath.trim()) continue;
    const kind =
      rec.kind === 'TS_CALL_MISMATCH' ||
      rec.kind === 'TS_RETURN_MISMATCH' ||
      rec.kind === 'PORT_SCHEMA_MISMATCH'
        ? rec.kind
        : 'PORT_SCHEMA_MISMATCH';
    out.push({
      kind,
      ...(typeof rec.tsCode === 'number' ? { tsCode: rec.tsCode } : {}),
      message: rec.message.trim(),
      filePath: rec.filePath.trim(),
      ...(typeof rec.lineNumber === 'number' && rec.lineNumber > 0
        ? { lineNumber: rec.lineNumber }
        : {}),
      ...(typeof rec.peerEntityId === 'string' && rec.peerEntityId.trim()
        ? { peerEntityId: rec.peerEntityId.trim() }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Coerces raw node metadata (`portValves`, `inputTypes`, `outputType`) and any non-stale `L1_PORTS`
 * overlay rows into a single canonical {@link ContractPortValves} record (`[PAT-VIS-14]`).
 *
 * Stale `L1_PORTS` overlays (`stale === true` due to `bodyHash` or referenced `inputs` file edits)
 * are ignored for diagnostics and never override fresh Speed 1 AST signatures, preventing ghost errors
 * during the sub-second window before Speed 2 background re-verification finishes.
 *
 * @param baseMeta - Node metadata or partial port fields (`portValves`, `inputTypes`, `outputType`).
 * @param overlays - Optional entity overlays for this node (filtered internally to `layer === "L1_PORTS"`).
 * @returns Merged {@link ContractPortValves} when any port evidence exists, otherwise `undefined`.
 */
export function mergeContractPortValves(
  baseMeta?: {
    portValves?: ContractPortValves | Record<string, unknown> | null;
    inputTypes?: string[];
    outputType?: string;
  } | null,
  overlays?: readonly PortOverlayLike[] | null
): ContractPortValves | undefined {
  let tier: PortVerificationTier = 'syntactic';
  let origin: PortSchemaOrigin = 'ts-signature';
  const inputTypesSet = new Set<string>();
  let outputType: string | undefined;
  let inputs: PortParameterValve[] | undefined;
  let output: PortOutputValve | undefined;
  let zeroInputs = false;
  const diagnostics: PortDiagnostic[] = [];
  let hasAnyEvidence = false;

  if (baseMeta) {
    if (Array.isArray(baseMeta.inputTypes)) {
      for (const t of baseMeta.inputTypes) {
        if (typeof t === 'string' && t.trim()) {
          inputTypesSet.add(t.trim());
          hasAnyEvidence = true;
        }
      }
    }
    if (typeof baseMeta.outputType === 'string' && baseMeta.outputType.trim()) {
      outputType = baseMeta.outputType.trim();
      hasAnyEvidence = true;
    }

    const rawPv = baseMeta.portValves as Record<string, unknown> | undefined;
    if (rawPv && typeof rawPv === 'object') {
      if (rawPv.tier === 'syntactic' || rawPv.tier === 'typechecked' || rawPv.tier === 'spec') {
        tier = rawPv.tier;
      }
      if (typeof rawPv.origin === 'string') {
        origin = rawPv.origin as PortSchemaOrigin;
      }
      if (Array.isArray(rawPv.inputTypes)) {
        for (const t of rawPv.inputTypes) {
          if (typeof t === 'string' && t.trim()) {
            inputTypesSet.add(t.trim());
            hasAnyEvidence = true;
          }
        }
      }
      if (typeof rawPv.outputType === 'string' && rawPv.outputType.trim()) {
        outputType = rawPv.outputType.trim();
        hasAnyEvidence = true;
      }
      const parsedInputs = sanitizeInputs(rawPv.inputs);
      if (parsedInputs) {
        inputs = parsedInputs;
        hasAnyEvidence = true;
      }
      const parsedOutput = sanitizeOutput(rawPv.output);
      if (parsedOutput) {
        output = parsedOutput;
        hasAnyEvidence = true;
      }
      if (rawPv.zeroInputs === true) {
        zeroInputs = true;
        hasAnyEvidence = true;
      }
      const parsedDiags = sanitizeDiagnostics(rawPv.diagnostics);
      if (parsedDiags) {
        diagnostics.push(...parsedDiags);
        hasAnyEvidence = true;
      }
    }
  }

  if (Array.isArray(overlays)) {
    for (const ov of overlays) {
      if (!ov || (ov.layer && ov.layer !== 'L1_PORTS')) continue;
      if (ov.stale) continue;
      const p = (ov.payload?.portValves ?? ov.payload) as Record<string, unknown> | undefined;
      if (!p || typeof p !== 'object') continue;

      const ovTier: PortVerificationTier =
        p.tier === 'spec'
          ? 'spec'
          : p.tier === 'typechecked'
            ? 'typechecked'
            : 'typechecked';
      if (TIER_RANK[ovTier] >= TIER_RANK[tier]) {
        tier = ovTier;
        if (typeof p.origin === 'string') {
          origin = p.origin as PortSchemaOrigin;
        } else if (ovTier === 'typechecked') {
          origin = 'ts-typecheck';
        }
      }

      if (Array.isArray(p.inputTypes)) {
        for (const t of p.inputTypes) {
          if (typeof t === 'string' && t.trim()) {
            inputTypesSet.add(t.trim());
            hasAnyEvidence = true;
          }
        }
      }
      if (typeof p.outputType === 'string' && p.outputType.trim()) {
        outputType = p.outputType.trim();
        hasAnyEvidence = true;
      }

      const ovInputs = sanitizeInputs(p.inputs);
      if (ovInputs) {
        if (!inputs) {
          inputs = ovInputs;
        } else {
          const byName = new Map(ovInputs.map((item) => [item.name, item]));
          const mergedParams: PortParameterValve[] = inputs.map((baseParam, idx) => {
            const match = byName.get(baseParam.name) ?? ovInputs[idx];
            if (!match) return baseParam;
            return {
              name: baseParam.name,
              type:
                match.type && match.type !== 'unknown' && match.type !== 'any'
                  ? match.type
                  : baseParam.type,
              ...(baseParam.optional || match.optional ? { optional: true } : {}),
              ...(match.fields ?? baseParam.fields
                ? { fields: match.fields ?? baseParam.fields }
                : {}),
              ...(match.declaration ?? baseParam.declaration
                ? { declaration: match.declaration ?? baseParam.declaration }
                : {}),
            };
          });
          if (ovInputs.length > mergedParams.length) {
            mergedParams.push(...ovInputs.slice(mergedParams.length));
          }
          inputs = mergedParams;
        }
        hasAnyEvidence = true;
      }

      const ovOutput = sanitizeOutput(p.output);
      if (ovOutput) {
        output = output
          ? {
              type:
                ovOutput.type && ovOutput.type !== 'unknown' && ovOutput.type !== 'any'
                  ? ovOutput.type
                  : output.type,
              ...(output.async || ovOutput.async ? { async: true } : {}),
              ...(ovOutput.fields ?? output.fields
                ? { fields: ovOutput.fields ?? output.fields }
                : {}),
              ...(ovOutput.declaration ?? output.declaration
                ? { declaration: ovOutput.declaration ?? output.declaration }
                : {}),
            }
          : ovOutput;
        hasAnyEvidence = true;
      }

      if (p.zeroInputs === true) {
        zeroInputs = true;
        hasAnyEvidence = true;
      }

      const ovDiags = sanitizeDiagnostics(p.diagnostics);
      if (ovDiags) {
        const seen = new Set(
          diagnostics.map((d) => `${d.kind}:${d.filePath}:${d.lineNumber ?? 0}:${d.message}`)
        );
        for (const d of ovDiags) {
          const key = `${d.kind}:${d.filePath}:${d.lineNumber ?? 0}:${d.message}`;
          if (!seen.has(key)) {
            seen.add(key);
            diagnostics.push(d);
          }
        }
        hasAnyEvidence = true;
      }
    }
  }

  if (!hasAnyEvidence) return undefined;

  const inputTypes = inputTypesSet.size > 0 ? Array.from(inputTypesSet) : undefined;
  return {
    tier,
    origin,
    ...(inputTypes ? { inputTypes } : {}),
    ...(outputType ? { outputType } : {}),
    ...(inputs && inputs.length > 0 ? { inputs } : {}),
    ...(output ? { output } : {}),
    ...(zeroInputs && (!inputs || inputs.length === 0) ? { zeroInputs: true } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
