import {
  retrieveDiagnosticContext,
  type ContextRetrievalLimits,
  type DiagnosticContext,
} from "./context-retrieval";
import {
  retrieveDebugHistoriesForDiagnostic,
  type HistoryRecord,
} from "./history";

export type AssemblerLimits = {
  readonly context?: ContextRetrievalLimits;
  readonly maxSessions?: number;
  readonly maxAttemptsPerSession?: number;
};

export type ContextFact = {
  readonly id: string;
  readonly category: "current-diagnostic" | "code-context" | "historical";
  readonly statement: string;
  readonly sourceIds: readonly string[];
  readonly observed: "direct" | "inferred";
};

export type ContextRecommendation = {
  readonly action: string;
  readonly reason: string;
  readonly supportingRecordIds: readonly string[];
  readonly supportingContextIds: readonly string[];
  readonly uncertainty: string;
};

export type AssembledDebugContext = {
  readonly diagnostic: DiagnosticContext["diagnostic"];
  readonly codeContext: DiagnosticContext;
  readonly historicalSessions: readonly HistoryRecord[];
  readonly facts: readonly ContextFact[];
  readonly hypotheses: HistoryRecord["hypothesis"];
  readonly outcomes: HistoryRecord["outcomes"];
  readonly evidence: HistoryRecord["evidence"];
  readonly recommendations: readonly ContextRecommendation[];
  readonly metadata: {
    readonly graphName: string;
    readonly diagnosticId: string;
    readonly limits: {
      readonly maxSessions: number;
      readonly maxAttemptsPerSession: number;
    };
  };
};

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_ATTEMPTS = 100;

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function limitsOf(value: AssemblerLimits): Required<Pick<AssemblerLimits, "maxSessions" | "maxAttemptsPerSession">> {
  const maxSessions = value.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxAttemptsPerSession = value.maxAttemptsPerSession ?? DEFAULT_MAX_ATTEMPTS;
  requirePositiveInteger(maxSessions, "maxSessions");
  requirePositiveInteger(maxAttemptsPerSession, "maxAttemptsPerSession");
  return { maxSessions, maxAttemptsPerSession };
}

function attemptsWithFailedOutcome(history: HistoryRecord): readonly HistoryRecord["attempts"][number][] {
  return history.attempts.filter((attempt) => attempt.outcome === "failed");
}

function evidenceForAttempt(history: HistoryRecord, attemptId: string) {
  return history.evidence.filter((item) => item.attemptId === attemptId);
}

export function deriveRecommendations(
  diagnosticContext: DiagnosticContext,
  histories: readonly HistoryRecord[],
): readonly ContextRecommendation[] {
  const recommendations: ContextRecommendation[] = [];
  const contextIds = diagnosticContext.items.map((item) => item.id);
  const failedAttempts = histories.flatMap((history) =>
    attemptsWithFailedOutcome(history).map((attempt) => ({ history, attempt })),
  );

  for (const { history, attempt } of failedAttempts) {
    const evidence = evidenceForAttempt(history, attempt.id);
    const supportingIds = [
      history.session.id,
      ...history.hypothesis.filter((hypothesis) =>
        history.relationships.some((relationship) =>
          relationship.type === "TESTED_BY"
          && relationship.fromId === hypothesis.id
          && relationship.toId === attempt.id,
        ),
      ).map((hypothesis) => hypothesis.id),
      attempt.id,
      ...evidence.map((item) => item.id),
    ];
    recommendations.push({
      action: `Avoid repeating attempt "${attempt.testCommand ?? attempt.id}" without new evidence`,
      reason: "A historical attempt was recorded with a failed outcome.",
      supportingRecordIds: supportingIds,
      supportingContextIds: contextIds,
      uncertainty: "This is historical evidence only; it does not establish the current diagnostic's cause or status.",
    });
  }

  const unresolved = histories.flatMap((history) =>
    history.hypothesis
      .filter((hypothesis) => hypothesis.status !== "resolved")
      .map((hypothesis) => ({ history, hypothesis })),
  );
  if (unresolved.length > 0 && diagnosticContext.items.length > 0) {
    const first = unresolved[0];
    recommendations.push({
      action: `Investigate hypothesis "${first.hypothesis.statement}" against the relevant code context`,
      reason: "The hypothesis remains unresolved and bounded code context is available.",
      supportingRecordIds: [first.history.session.id, first.hypothesis.id],
      supportingContextIds: contextIds,
      uncertainty: "The hypothesis is recorded, not confirmed; additional diagnostic or test evidence is required.",
    });
  }

  const hasEvidence = histories.some((history) => history.evidence.length > 0);
  const hasUnevaluated = histories.some((history) =>
    history.attempts.some((attempt) => attempt.outcome === "unevaluated"),
  );
  if (!hasEvidence || hasUnevaluated) {
    recommendations.push({
      action: "Run a focused diagnostic or test that directly evaluates the unresolved history",
      reason: hasUnevaluated
        ? "At least one historical attempt is unevaluated."
        : "No historical evidence is available for the associated sessions.",
      supportingRecordIds: histories.flatMap((history) =>
        [history.session.id, ...history.attempts.map((attempt) => attempt.id)],
      ),
      supportingContextIds: [diagnosticContext.diagnostic.id, ...contextIds],
      uncertainty: "The available records are insufficient to establish whether a proposed approach works.",
    });
  }

  return recommendations.sort((left, right) =>
    `${left.action}:${left.supportingRecordIds.join(",")}`.localeCompare(
      `${right.action}:${right.supportingRecordIds.join(",")}`,
    ),
  );
}

function buildFacts(codeContext: DiagnosticContext, histories: readonly HistoryRecord[]): readonly ContextFact[] {
  const facts: ContextFact[] = [{
    id: `diagnostic:${codeContext.diagnostic.id}`,
    category: "current-diagnostic",
    statement: `Current diagnostic ${codeContext.diagnostic.code}: ${codeContext.diagnostic.message}`,
    sourceIds: [codeContext.diagnostic.id],
    observed: "direct",
  }];
  facts.push(...codeContext.items.map((item) => ({
    id: `${item.kind}:${item.id}`,
    category: "code-context" as const,
    statement: `${item.kind} ${item.filePath ?? item.name ?? item.id} is relevant to the current diagnostic`,
    sourceIds: [item.id],
    observed: item.provenance.observed,
  })));
  facts.push(...histories.flatMap((history) => history.evidence.map((evidence) => ({
    id: `evidence:${evidence.id}`,
    category: "historical" as const,
    statement: evidence.summary,
    sourceIds: [history.session.id, evidence.id],
    observed: "direct" as const,
  }))));
  return facts;
}

export async function assembleDebugContext(
  diagnosticId: string,
  requestedLimits: AssemblerLimits = {},
): Promise<AssembledDebugContext> {
  if (diagnosticId.trim().length === 0) {
    throw new Error("diagnosticId must not be empty");
  }
  const limits = limitsOf(requestedLimits);
  const codeContext = await retrieveDiagnosticContext(diagnosticId, requestedLimits.context);
  const historicalSessions = await retrieveDebugHistoriesForDiagnostic(
    diagnosticId,
    limits.maxSessions,
    limits.maxAttemptsPerSession,
  );
  const hypotheses = historicalSessions.flatMap((history) => history.hypothesis);
  const outcomes = historicalSessions.flatMap((history) => history.outcomes);
  const evidence = historicalSessions.flatMap((history) => history.evidence);
  return {
    diagnostic: codeContext.diagnostic,
    codeContext,
    historicalSessions,
    facts: buildFacts(codeContext, historicalSessions),
    hypotheses,
    outcomes,
    evidence,
    recommendations: deriveRecommendations(codeContext, historicalSessions),
    metadata: {
      graphName: codeContext.metadata.graphName,
      diagnosticId,
      limits,
    },
  };
}
