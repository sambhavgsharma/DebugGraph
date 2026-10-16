import {
  createOrReuseDebugSession,
  recordAttempt,
  recordAttemptOutcome,
  recordEvidence,
  recordHypothesis,
  recordPatch,
  retrieveDebugHistory,
} from "./debugging/history";

function usage(): never {
  throw new Error(
    "Usage: history <session|hypothesis|attempt|outcome|patch|evidence|show> " +
    "<JSON payload or session ID>",
  );
}

function payload(): Record<string, unknown> {
  const raw = process.argv[3];
  if (raw === undefined) usage();
  const value: unknown = JSON.parse(raw);
  if (!isObject(value)) {
    throw new Error("JSON payload must be an object");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value, "value");
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}

function outcome(value: unknown): "failed" | "successful" | "unevaluated" {
  const selected = text(value, "outcome");
  if (selected !== "failed" && selected !== "successful" && selected !== "unevaluated") {
    throw new Error("outcome must be failed, successful, or unevaluated");
  }
  return selected;
}

function attemptStatus(value: unknown): "planned" | "running" | "completed" | undefined {
  if (value === undefined) return undefined;
  const selected = text(value, "status");
  if (selected !== "planned" && selected !== "running" && selected !== "completed") {
    throw new Error("status must be planned, running, or completed");
  }
  return selected;
}

function evidenceRelation(value: unknown): "SUPPORTS" | "CONTRADICTS" | "VALIDATES" | undefined {
  if (value === undefined) return undefined;
  const selected = text(value, "relationToHypothesis");
  if (selected !== "SUPPORTS" && selected !== "CONTRADICTS" && selected !== "VALIDATES") {
    throw new Error("relationToHypothesis must be SUPPORTS, CONTRADICTS, or VALIDATES");
  }
  return selected;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined) usage();
  if (command === "show") {
    const sessionId = text(process.argv[3], "sessionId");
    console.log(JSON.stringify(await retrieveDebugHistory(sessionId), null, 2));
    return;
  }
  const input = payload();
  let result: unknown;
  switch (command) {
    case "session":
      result = await createOrReuseDebugSession({
        sessionId: optionalText(input.sessionId),
        diagnosticId: optionalText(input.diagnosticId),
        goal: text(input.goal, "goal"),
        baselineRevision: optionalText(input.baselineRevision),
      });
      break;
    case "hypothesis":
      result = await recordHypothesis({
        sessionId: text(input.sessionId, "sessionId"),
        statement: text(input.statement, "statement"),
        rootCauseCategory: optionalText(input.rootCauseCategory),
        status: optionalText(input.status),
        provenanceKind: text(input.provenanceKind, "provenanceKind"),
        rationale: optionalText(input.rationale),
        hypothesisFingerprint: optionalText(input.hypothesisFingerprint),
      });
      break;
    case "attempt":
      result = await recordAttempt({
        sessionId: text(input.sessionId, "sessionId"),
        hypothesisId: optionalText(input.hypothesisId),
        attemptId: optionalText(input.attemptId),
        sequenceNo: number(input.sequenceNo, "sequenceNo"),
        status: attemptStatus(input.status),
        startedAt: optionalText(input.startedAt),
        testCommand: optionalText(input.testCommand),
      });
      break;
    case "outcome":
      await recordAttemptOutcome(
        text(input.attemptId, "attemptId"),
        outcome(input.outcome),
        optionalText(input.resultSummary),
      );
      result = { attemptId: input.attemptId, outcome: input.outcome };
      break;
    case "patch":
      result = await recordPatch({
        attemptId: text(input.attemptId, "attemptId"),
        hypothesisId: optionalText(input.hypothesisId),
        patchHash: text(input.patchHash, "patchHash"),
        status: text(input.status, "status"),
        diffSummary: optionalText(input.diffSummary),
        diffRef: optionalText(input.diffRef),
      });
      break;
    case "evidence":
      result = await recordEvidence({
        attemptId: text(input.attemptId, "attemptId"),
        hypothesisId: optionalText(input.hypothesisId),
        kind: text(input.kind, "kind"),
        result: text(input.result, "result"),
        summary: text(input.summary, "summary"),
        sourceKind: text(input.sourceKind, "sourceKind"),
        sourceRef: optionalText(input.sourceRef),
        rawRef: optionalText(input.rawRef),
        testName: optionalText(input.testName),
        exitCode: input.exitCode === undefined ? undefined : number(input.exitCode, "exitCode"),
        relationToHypothesis: evidenceRelation(input.relationToHypothesis),
      });
      break;
    default:
      usage();
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error("Debugging history command failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
