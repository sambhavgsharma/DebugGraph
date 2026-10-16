import type { ContextRetrievalLimits } from "./context-retrieval";

// These caps bound the query fan-out while leaving the existing defaults unchanged.
// They are intentionally finite so callers cannot turn bounded retrieval into an
// unbounded graph scan.
export const DEFAULT_CONTEXT_LIMITS: Required<ContextRetrievalLimits> = {
  maxDiagnostics: 10,
  maxFileSymbols: 50,
  maxImportedFiles: 20,
  maxImportedFileSymbols: 20,
  maxCallers: 25,
  maxCallees: 25,
};

export const MAX_CONTEXT_LIMITS: Required<ContextRetrievalLimits> = {
  maxDiagnostics: 50,
  maxFileSymbols: 200,
  maxImportedFiles: 100,
  maxImportedFileSymbols: 100,
  maxCallers: 100,
  maxCallees: 100,
};

export const DEFAULT_MAX_SESSIONS = 20;
export const MAX_MAX_SESSIONS = 50;
export const DEFAULT_MAX_ATTEMPTS_PER_SESSION = 100;
export const MAX_MAX_ATTEMPTS_PER_SESSION = 500;

export function requireBoundedPositiveInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (value > maximum) {
    throw new Error(`${field} must not exceed ${maximum}`);
  }
  return value;
}

export function validateContextLimits(
  value: ContextRetrievalLimits = {},
): Required<ContextRetrievalLimits> {
  const limits = { ...DEFAULT_CONTEXT_LIMITS, ...value };
  for (const field of Object.keys(DEFAULT_CONTEXT_LIMITS) as Array<keyof ContextRetrievalLimits>) {
    requireBoundedPositiveInteger(limits[field], field, MAX_CONTEXT_LIMITS[field]);
  }
  return limits;
}
