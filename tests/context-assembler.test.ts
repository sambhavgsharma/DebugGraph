import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleDebugContext,
  deriveRecommendations,
} from "../src/debugging/context-assembler";
import {
  retrieveDiagnosticContext,
  type ContextRetrievalLimits,
  type DiagnosticContext,
} from "../src/debugging/context-retrieval";
import type { HistoryRecord } from "../src/debugging/history";
import { retrieveDebugHistoriesForDiagnostic } from "../src/debugging/history";
import {
  DEFAULT_CONTEXT_LIMITS,
  DEFAULT_MAX_ATTEMPTS_PER_SESSION,
  DEFAULT_MAX_SESSIONS,
  MAX_CONTEXT_LIMITS,
  MAX_MAX_ATTEMPTS_PER_SESSION,
  MAX_MAX_SESSIONS,
  validateContextLimits,
} from "../src/debugging/limits";

const diagnosticContext: DiagnosticContext = {
  diagnostic: {
    id: "diagnostic-1",
    severity: "error",
    code: 2322,
    message: "Type is not assignable",
  },
  items: [{
    id: "file-1",
    kind: "file",
    filePath: "src/example.ts",
    provenance: { reason: "diagnostic source file", relationship: "LOCATED_IN", observed: "direct" },
  }],
  relationships: [],
  metadata: {
    graphName: "DebugGraphDev",
    diagnosticId: "diagnostic-1",
    counts: { items: 1, files: 1, symbols: 0, relationships: 0 },
    limits: {
      maxDiagnostics: 10,
      maxFileSymbols: 50,
      maxImportedFiles: 20,
      maxImportedFileSymbols: 20,
      maxCallers: 25,
      maxCallees: 25,
    },
  },
};

function history(outcome?: "failed" | "unevaluated"): HistoryRecord {
  return {
    session: {
      id: "session-1",
      goal: "test",
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    hypothesis: [{
      id: "hypothesis-1",
      sessionId: "session-1",
      statement: "The contract is wrong",
      status: "proposed",
      provenanceKind: "test",
      hypothesisFingerprint: "fingerprint-1",
    }],
    attempts: [{
      id: "attempt-1",
      sessionId: "session-1",
      hypothesisId: "hypothesis-1",
      attemptId: "attempt-1",
      sequenceNo: 1,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      ...(outcome === undefined ? {} : { outcome }),
    }],
    patches: [],
    evidence: [],
    outcomes: outcome === undefined ? [] : [{
      attemptId: "attempt-1",
      status: "completed",
      outcome,
    }],
    relationships: [{
      type: "TESTED_BY",
      fromId: "hypothesis-1",
      toId: "attempt-1",
    }],
    metadata: {
      graphName: "DebugGraphDev",
      counts: { hypotheses: 1, attempts: 1, patches: 0, evidence: 0 },
      maxAttempts: 100,
    },
  };
}

test("failed history is evidence, not a current diagnostic conclusion", () => {
  const recommendations = deriveRecommendations(diagnosticContext, [history("failed")]);
  assert.ok(recommendations.some((item) => item.reason.includes("historical attempt")));
  assert.ok(recommendations.every((item) => !item.reason.includes("current diagnostic remains")));
});

test("unevaluated attempts do not produce a success recommendation", () => {
  const recommendations = deriveRecommendations(diagnosticContext, [history("unevaluated")]);
  assert.ok(recommendations.some((item) => item.reason.includes("unevaluated")));
  assert.ok(recommendations.every((item) => !item.action.toLowerCase().includes("success")));
});

test("missing evidence recommends a focused evaluation", () => {
  const recommendations = deriveRecommendations(diagnosticContext, [history()]);
  const recommendation = recommendations.find((item) => item.reason.includes("No historical evidence"));
  assert.ok(recommendation);
  assert.deepEqual(recommendation.supportingRecordIds, ["session-1", "attempt-1"]);
  assert.deepEqual(
    recommendation.supportingContextIds,
    ["diagnostic-1", "file-1"],
  );
});

test("an empty history still traces an evidence request to the diagnostic", () => {
  const recommendations = deriveRecommendations(
    { ...diagnosticContext, items: [] },
    [],
  );
  assert.equal(recommendations.length, 1);
  assert.deepEqual(
    recommendations[0].supportingContextIds,
    ["diagnostic-1"],
  );
  assert.match(recommendations[0].reason, /No historical evidence/);
});

test("shared defaults and maximum context limits are accepted", () => {
  assert.deepEqual(validateContextLimits(), DEFAULT_CONTEXT_LIMITS);
  assert.deepEqual(validateContextLimits(MAX_CONTEXT_LIMITS), MAX_CONTEXT_LIMITS);
  assert.equal(DEFAULT_MAX_SESSIONS, 20);
  assert.equal(DEFAULT_MAX_ATTEMPTS_PER_SESSION, 100);
  assert.equal(MAX_MAX_SESSIONS, 50);
  assert.equal(MAX_MAX_ATTEMPTS_PER_SESSION, 500);
});

test("direct debugging APIs reject limits above shared maximums", async () => {
  await assert.rejects(
    () => assembleDebugContext("diagnostic-1", {
      maxSessions: MAX_MAX_SESSIONS + 1,
    }),
    /maxSessions must not exceed 50/,
  );
  await assert.rejects(
    () => assembleDebugContext("diagnostic-1", {
      maxAttemptsPerSession: MAX_MAX_ATTEMPTS_PER_SESSION + 1,
    }),
    /maxAttemptsPerSession must not exceed 500/,
  );
  for (const field of Object.keys(MAX_CONTEXT_LIMITS) as Array<keyof ContextRetrievalLimits>) {
    await assert.rejects(
      () => retrieveDiagnosticContext("diagnostic-1", {
        [field]: MAX_CONTEXT_LIMITS[field] + 1,
      }),
      new RegExp(`${field} must not exceed ${MAX_CONTEXT_LIMITS[field]}`),
    );
  }
  await assert.rejects(
    () => retrieveDebugHistoriesForDiagnostic(
      "diagnostic-1",
      MAX_MAX_SESSIONS + 1,
    ),
    /maxSessions must not exceed 50/,
  );
  await assert.rejects(
    () => retrieveDebugHistoriesForDiagnostic(
      "diagnostic-1",
      DEFAULT_MAX_SESSIONS,
      MAX_MAX_ATTEMPTS_PER_SESSION + 1,
    ),
    /maxAttempts must not exceed 500/,
  );
});
