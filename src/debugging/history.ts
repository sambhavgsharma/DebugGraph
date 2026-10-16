import { createHash } from "node:crypto";
import { connectToGraph, graphName } from "../graph/client";

type QueryRow = Readonly<Record<string, unknown>>;

export type DebugSessionInput = {
  readonly sessionId?: string;
  readonly diagnosticId?: string;
  readonly goal: string;
  readonly baselineRevision?: string;
};

export type DebugSession = {
  readonly id: string;
  readonly diagnosticId?: string;
  readonly goal: string;
  readonly status: string;
  readonly startedAt: string;
  readonly baselineRevision?: string;
};

export type HypothesisInput = {
  readonly sessionId: string;
  readonly statement: string;
  readonly rootCauseCategory?: string;
  readonly status?: string;
  readonly provenanceKind: string;
  readonly rationale?: string;
  readonly hypothesisFingerprint?: string;
};

export type DebugHypothesis = HypothesisInput & {
  readonly id: string;
  readonly hypothesisFingerprint: string;
};

export type AttemptInput = {
  readonly sessionId: string;
  readonly hypothesisId?: string;
  readonly attemptId?: string;
  readonly sequenceNo: number;
  readonly status?: "planned" | "running" | "completed";
  readonly startedAt?: string;
  readonly testCommand?: string;
};

export type DebugAttempt = AttemptInput & {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string;
};

export type PatchInput = {
  readonly attemptId: string;
  readonly hypothesisId?: string;
  readonly patchHash: string;
  readonly status: string;
  readonly diffSummary?: string;
  readonly diffRef?: string;
};

export type DebugPatch = PatchInput & {
  readonly id: string;
  readonly createdAt: string;
};

export type EvidenceInput = {
  readonly attemptId: string;
  readonly hypothesisId?: string;
  readonly kind: string;
  readonly result: string;
  readonly summary: string;
  readonly sourceKind: string;
  readonly sourceRef?: string;
  readonly rawRef?: string;
  readonly testName?: string;
  readonly exitCode?: number;
  readonly relationToHypothesis?: "SUPPORTS" | "CONTRADICTS" | "VALIDATES";
};

export type DebugEvidence = EvidenceInput & {
  readonly id: string;
  readonly observedAt: string;
  readonly collectedAt: string;
};

export type AttemptOutcome = "failed" | "successful" | "unevaluated";

export type HistoryRecord = {
  readonly session: DebugSession;
  readonly hypothesis: readonly DebugHypothesis[];
  readonly attempts: readonly DebugAttempt[];
  readonly patches: readonly DebugPatch[];
  readonly evidence: readonly DebugEvidence[];
  readonly outcomes: readonly {
    readonly attemptId: string;
    readonly status: string;
    readonly outcome?: AttemptOutcome;
    readonly resultSummary?: string;
  }[];
  readonly relationships: readonly {
    readonly type:
      | "TARGETS"
      | "HAS_HYPOTHESIS"
      | "HAS_ATTEMPT"
      | "TESTED_BY"
      | "FOLLOWS"
      | "APPLIES"
      | "HAS_EVIDENCE"
      | "SUPPORTS"
      | "CONTRADICTS"
      | "VALIDATES";
    readonly fromId: string;
    readonly toId: string;
  }[];
  readonly metadata: {
    readonly graphName: string;
    readonly counts: {
      readonly hypotheses: number;
      readonly attempts: number;
      readonly patches: number;
      readonly evidence: number;
    };
    readonly maxAttempts: number;
  };
};

const MAX_ATTEMPTS = 100;
const MAX_HYPOTHESES = 100;
const MAX_PATCHES = 200;
const MAX_EVIDENCE = 300;

function stableId(kind: string, identity: string): string {
  return createHash("sha256").update(`${kind}:${identity}`).digest("hex");
}

function requireText(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function optionalText(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireText(value, field);
}

function attemptStatusInput(value: AttemptInput["status"]): "planned" | "running" | "completed" {
  if (value === undefined || value === "planned" || value === "running" || value === "completed") {
    return value ?? "planned";
  }
  throw new Error(`Unsupported debug attempt status "${value}"`);
}

function evidenceRelation(value: EvidenceInput["relationToHypothesis"]): "SUPPORTS" | "CONTRADICTS" | "VALIDATES" | undefined {
  if (
    value === undefined
    || value === "SUPPORTS"
    || value === "CONTRADICTS"
    || value === "VALIDATES"
  ) {
    return value;
  }
  throw new Error(`Unsupported evidence relation "${value}"`);
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsOf(data: readonly unknown[] | undefined, name: string): readonly QueryRow[] {
  return (data ?? []).map((value, index) => {
    if (!isQueryRow(value)) {
      throw new Error(`${name} returned an unexpected row at index ${index}`);
    }
    return value;
  });
}

function stringField(row: QueryRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`History query result field "${field}" was not a string`);
  }
  return value;
}

function optionalStringField(row: QueryRow, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  return typeof value === "string"
    ? value
    : (() => { throw new Error(`History query result field "${field}" was not a string or null`); })();
}

function numberField(row: QueryRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`History query result field "${field}" was not a finite number`);
  }
  return value;
}

function optionalNumberField(row: QueryRow, field: string): number | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  return typeof value === "number"
    ? value
    : (() => { throw new Error(`History query result field "${field}" was not a number or null`); })();
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

async function queryOne(
  graph: import("falkordb").Graph,
  query: string,
  params: Record<string, string | number | null>,
  name: string,
): Promise<QueryRow> {
  const rows = rowsOf((await graph.roQuery<QueryRow>(query, { params })).data, name);
  if (rows.length !== 1) throw new Error(`${name} did not return exactly one row`);
  return rows[0];
}

function attemptStatus(value: string): "planned" | "running" | "completed" {
  if (value === "planned" || value === "running" || value === "completed") {
    return value;
  }

  throw new Error(`Unexpected debug attempt status "${value}"`);
}

export async function createOrReuseDebugSession(
  input: DebugSessionInput,
): Promise<DebugSession> {
  requireText(input.goal, "goal");
  const diagnosticId = optionalText(input.diagnosticId, "diagnosticId");
  const baselineRevision = optionalText(input.baselineRevision, "baselineRevision");
  const normalizedGoal = input.goal.trim().replace(/\s+/g, " ");
  const sessionId = input.sessionId === undefined
    ? stableId("debug-session", `${diagnosticId ?? "<none>"}:${normalizedGoal}:${baselineRevision ?? "<none>"}`)
    : requireText(input.sessionId, "sessionId");
  const startedAt = new Date().toISOString();
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const existing = await graph.roQuery<QueryRow>(
      `
        MATCH (s:Session {id: $sessionId})
        OPTIONAL MATCH (s)-[:TARGETS]->(d:Diagnostic)
        RETURN s.goal AS goal, s.baselineRevision AS baselineRevision,
               s.status AS status, s.startedAt AS startedAt,
               d.id AS diagnosticId
      `,
      { params: { sessionId } },
    );
    const existingRow = rowsOf(existing.data, "debug session identity lookup")[0];
    if (existingRow !== undefined) {
      const existingGoal = stringField(existingRow, "goal");
      const existingBaseline = optionalStringField(existingRow, "baselineRevision");
      const existingDiagnostic = optionalStringField(existingRow, "diagnosticId");
      if (
        existingGoal.trim().replace(/\s+/g, " ") !== normalizedGoal
        || !sameOptional(existingBaseline, baselineRevision)
        || (diagnosticId !== undefined && existingDiagnostic !== undefined && existingDiagnostic !== diagnosticId)
      ) {
        throw new Error(`Session "${sessionId}" already exists with conflicting identity metadata`);
      }
    }
    await graph.query(
      `
        MERGE (s:Session {id: $sessionId})
        ON CREATE SET s.goal = $goal,
                      s.status = 'active',
                      s.problemFingerprint = $problemFingerprint,
                      s.startedAt = $startedAt,
                      s.baselineRevision = $baselineRevision
      `,
      {
        params: {
          sessionId,
          goal: input.goal,
          problemFingerprint: stableId("debug-problem", `${diagnosticId ?? sessionId}:${baselineRevision ?? "<none>"}`),
          startedAt,
          baselineRevision: baselineRevision ?? null,
        },
      },
    );
    if (diagnosticId !== undefined) {
      await graph.query(
        `
          MATCH (s:Session {id: $sessionId}), (d:Diagnostic {id: $diagnosticId})
          MERGE (s)-[r:TARGETS]->(d)
          ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'manual'
        `,
        { params: { sessionId, diagnosticId, createdAt: startedAt } },
      );
    }
    const row = await queryOne(
      graph,
      `
        MATCH (s:Session {id: $sessionId})
        OPTIONAL MATCH (s)-[:TARGETS]->(d:Diagnostic)
        RETURN s.id AS id, s.goal AS goal, s.status AS status,
               s.startedAt AS startedAt, s.baselineRevision AS baselineRevision,
               d.id AS diagnosticId
        LIMIT 1
      `,
      { sessionId },
      "debug session lookup",
    );
    return {
      id: stringField(row, "id"),
      goal: stringField(row, "goal"),
      status: stringField(row, "status"),
      startedAt: stringField(row, "startedAt"),
      ...(optionalStringField(row, "baselineRevision") === undefined
        ? {} : { baselineRevision: optionalStringField(row, "baselineRevision") }),
      ...(optionalStringField(row, "diagnosticId") === undefined
        ? {} : { diagnosticId: optionalStringField(row, "diagnosticId") }),
    };
  } finally {
    await db.close();
  }
}

export async function recordHypothesis(input: HypothesisInput): Promise<DebugHypothesis> {
  requireText(input.sessionId, "sessionId");
  requireText(input.statement, "statement");
  requireText(input.provenanceKind, "provenanceKind");
  const suppliedFingerprint = input.hypothesisFingerprint
    ? requireText(input.hypothesisFingerprint, "hypothesisFingerprint")
    : input.statement;
  const fingerprint = stableId("hypothesis", `${input.sessionId}:${suppliedFingerprint}`);
  const id = stableId("hypothesis-node", `${input.sessionId}:${fingerprint}`);
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const session = await graph.roQuery<QueryRow>(
      `MATCH (s:Session {id: $sessionId}) RETURN s.id AS id`,
      { params: { sessionId: input.sessionId } },
    );
    if (rowsOf(session.data, "hypothesis session lookup").length !== 1) {
      throw new Error(`Session "${input.sessionId}" was not found`);
    }
    const existing = await graph.roQuery<QueryRow>(
      `
        MATCH (h:Hypothesis {id: $id})
        RETURN h.statement AS statement, h.rootCauseCategory AS rootCauseCategory,
               h.status AS status, h.provenanceKind AS provenanceKind,
               h.rationale AS rationale
      `,
      { params: { id } },
    );
    const existingRow = rowsOf(existing.data, "hypothesis identity lookup")[0];
    if (existingRow !== undefined && (
      stringField(existingRow, "statement") !== input.statement
      || !sameOptional(optionalStringField(existingRow, "rootCauseCategory"), input.rootCauseCategory)
      || stringField(existingRow, "status") !== (input.status ?? "proposed")
      || stringField(existingRow, "provenanceKind") !== input.provenanceKind
      || !sameOptional(optionalStringField(existingRow, "rationale"), input.rationale)
    )) {
      throw new Error(`Hypothesis "${id}" already exists with conflicting metadata`);
    }
    await graph.query(
      `
        MATCH (session:Session {id: $sessionId})
        MERGE (h:Hypothesis {id: $id})
        ON CREATE SET h.statement = $statement,
                      h.rootCauseCategory = $rootCauseCategory,
                      h.status = $status,
                      h.hypothesisFingerprint = $fingerprint,
                      h.provenanceKind = $provenanceKind,
                      h.rationale = $rationale,
                      h.createdAt = $createdAt,
                      h.updatedAt = $createdAt
        MERGE (session)-[r:HAS_HYPOTHESIS]->(h)
        ON CREATE SET r.createdAt = $createdAt, r.sourceKind = $provenanceKind
      `,
      {
        params: {
          sessionId: input.sessionId,
          id,
          statement: input.statement,
          rootCauseCategory: input.rootCauseCategory ?? null,
          status: input.status ?? "proposed",
          fingerprint,
          provenanceKind: input.provenanceKind,
          rationale: input.rationale ?? null,
          createdAt: new Date().toISOString(),
        },
      },
    );
    const persisted = await queryOne(
      graph,
      `
        MATCH (h:Hypothesis {id: $id})
        RETURN h.statement AS statement, h.rootCauseCategory AS rootCauseCategory,
               h.status AS status, h.hypothesisFingerprint AS hypothesisFingerprint,
               h.provenanceKind AS provenanceKind, h.rationale AS rationale
      `,
      { id },
      "hypothesis persistence lookup",
    );
    return {
      sessionId: input.sessionId,
      statement: stringField(persisted, "statement"),
      ...(optionalStringField(persisted, "rootCauseCategory") === undefined
        ? {} : { rootCauseCategory: optionalStringField(persisted, "rootCauseCategory") }),
      status: stringField(persisted, "status"),
      provenanceKind: stringField(persisted, "provenanceKind"),
      ...(optionalStringField(persisted, "rationale") === undefined
        ? {} : { rationale: optionalStringField(persisted, "rationale") }),
      id,
      hypothesisFingerprint: stringField(persisted, "hypothesisFingerprint"),
    };
  } finally {
    await db.close();
  }
}

export async function recordAttempt(input: AttemptInput): Promise<DebugAttempt> {
  requireText(input.sessionId, "sessionId");
  requirePositiveInteger(input.sequenceNo, "sequenceNo");
  const status = attemptStatusInput(input.status);
  if (input.attemptId === undefined) {
    throw new Error("attemptId is required for repeatable history writes");
  }
  const id = requireText(input.attemptId, "attemptId");
  const startedAt = input.startedAt ?? new Date().toISOString();
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const session = await graph.roQuery<QueryRow>(
      `MATCH (s:Session {id: $sessionId}) RETURN s.id AS id`,
      { params: { sessionId: input.sessionId } },
    );
    if (rowsOf(session.data, "attempt session lookup").length !== 1) {
      throw new Error(`Session "${input.sessionId}" was not found`);
    }
    if (input.hypothesisId !== undefined) {
      const hypothesis = await graph.roQuery<QueryRow>(
        `MATCH (h:Hypothesis {id: $hypothesisId}) RETURN h.id AS id`,
        { params: { hypothesisId: input.hypothesisId } },
      );
      if (rowsOf(hypothesis.data, "attempt hypothesis lookup").length !== 1) {
        throw new Error(`Hypothesis "${input.hypothesisId}" was not found`);
      }
    }
    const existing = await graph.roQuery<QueryRow>(
      `
        MATCH (a:DebugAttempt {id: $id})
        OPTIONAL MATCH (owner:Session)-[:HAS_ATTEMPT]->(a)
        OPTIONAL MATCH (ownerHypothesis:Hypothesis)-[:TESTED_BY]->(a)
        RETURN a.sequenceNo AS sequenceNo, a.status AS status,
               a.startedAt AS startedAt, owner.id AS sessionId,
               ownerHypothesis.id AS hypothesisId
      `,
      { params: { id } },
    );
    const existingRow = rowsOf(existing.data, "attempt identity lookup")[0];
    if (existingRow !== undefined) {
      const existingSession = stringField(existingRow, "sessionId");
      if (
        existingSession !== input.sessionId
        || numberField(existingRow, "sequenceNo") !== input.sequenceNo
        || !sameOptional(
          optionalStringField(existingRow, "hypothesisId"),
          input.hypothesisId,
        )
      ) {
        throw new Error(`Attempt "${id}" already exists with conflicting session, hypothesis, or sequence`);
      }
    }
    const sequence = await graph.roQuery<QueryRow>(
      `
        MATCH (session:Session {id: $sessionId})-[:HAS_ATTEMPT]->(a:DebugAttempt)
        WHERE a.sequenceNo = $sequenceNo AND a.id <> $id
        RETURN a.id AS id
      `,
      { params: { sessionId: input.sessionId, sequenceNo: input.sequenceNo, id } },
    );
    if (rowsOf(sequence.data, "attempt sequence lookup").length > 0) {
      throw new Error(`Session "${input.sessionId}" already has an attempt at sequence ${input.sequenceNo}`);
    }
    await graph.query(
      `
        MATCH (session:Session {id: $sessionId})
        MERGE (a:DebugAttempt {id: $id})
        ON CREATE SET a.sequenceNo = $sequenceNo,
                      a.status = $status,
                      a.startedAt = $startedAt,
                      a.testCommand = $testCommand
        MERGE (session)-[sr:HAS_ATTEMPT]->(a)
        ON CREATE SET sr.createdAt = $createdAt, sr.sourceKind = 'manual'
        WITH session, a
        OPTIONAL MATCH (session)-[:HAS_ATTEMPT]->(previous:DebugAttempt)
        WHERE previous.sequenceNo = $previousSequence
        WITH session, a, previous
        FOREACH (item IN CASE WHEN previous IS NULL THEN [] ELSE [previous] END |
          MERGE (previous)-[r:FOLLOWS]->(a)
          ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'manual')
        WITH session, a
        OPTIONAL MATCH (session)-[:HAS_ATTEMPT]->(successor:DebugAttempt)
        WHERE successor.sequenceNo = $nextSequence
        FOREACH (item IN CASE WHEN successor IS NULL THEN [] ELSE [successor] END |
          MERGE (a)-[r:FOLLOWS]->(successor)
          ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'manual')
      `,
      {
        params: {
          sessionId: input.sessionId,
          id,
          sequenceNo: input.sequenceNo,
          previousSequence: input.sequenceNo - 1,
          nextSequence: input.sequenceNo + 1,
          status,
          startedAt,
          testCommand: input.testCommand ?? null,
          createdAt: new Date().toISOString(),
        },
      },
    );
    if (input.hypothesisId !== undefined) {
      await graph.query(
        `
          MATCH (h:Hypothesis {id: $hypothesisId}), (a:DebugAttempt {id: $attemptId})
          MERGE (h)-[r:TESTED_BY]->(a)
          ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'manual'
        `,
        { params: { hypothesisId: input.hypothesisId, attemptId: id, createdAt: new Date().toISOString() } },
      );
    }
    const persisted = await queryOne(
      graph,
      `
        MATCH (a:DebugAttempt {id: $id})
        RETURN a.id AS id, a.sequenceNo AS sequenceNo, a.status AS status,
               a.startedAt AS startedAt, a.testCommand AS testCommand
      `,
      { id },
      "attempt persistence lookup",
    );
    return {
      sessionId: input.sessionId,
      ...(input.hypothesisId === undefined ? {} : { hypothesisId: input.hypothesisId }),
      id: stringField(persisted, "id"),
      sequenceNo: numberField(persisted, "sequenceNo"),
      status: attemptStatus(stringField(persisted, "status")),
      startedAt: stringField(persisted, "startedAt"),
      ...(optionalStringField(persisted, "testCommand") === undefined
        ? {} : { testCommand: optionalStringField(persisted, "testCommand") }),
    };
  } finally {
    await db.close();
  }
}

export async function recordAttemptOutcome(
  attemptId: string,
  outcome: AttemptOutcome,
  resultSummary?: string,
): Promise<void> {
  requireText(attemptId, "attemptId");
  if (outcome !== "failed" && outcome !== "successful" && outcome !== "unevaluated") {
    throw new Error(`Unsupported attempt outcome "${outcome}"`);
  }
  optionalText(resultSummary, "resultSummary");
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const existing = await queryOne(
      graph,
      `MATCH (a:DebugAttempt {id: $attemptId})
       RETURN a.outcome AS outcome, a.resultSummary AS resultSummary`,
      { attemptId },
      "attempt outcome identity lookup",
    );
    const existingOutcome = optionalStringField(existing, "outcome");
    const existingSummary = optionalStringField(existing, "resultSummary");
    if (existingOutcome !== undefined && existingOutcome !== outcome) {
      throw new Error(`Attempt "${attemptId}" already has a conflicting outcome`);
    }
    if (
      existingOutcome === outcome
      && !sameOptional(existingSummary, resultSummary)
    ) {
      throw new Error(`Attempt "${attemptId}" already has a conflicting result summary`);
    }
    await graph.query(
      `
        MATCH (a:DebugAttempt {id: $attemptId})
        WITH a, a.outcome AS existingOutcome
        WHERE existingOutcome IS NULL OR existingOutcome = $outcome
        SET a.outcome = $outcome,
            a.resultSummary = CASE
              WHEN existingOutcome IS NULL THEN $resultSummary
              ELSE a.resultSummary
            END,
            a.completedAt = CASE WHEN $outcome = 'unevaluated' THEN a.completedAt ELSE coalesce(a.completedAt, $completedAt) END,
            a.status = CASE WHEN $outcome = 'unevaluated' THEN a.status ELSE 'completed' END
      `,
      {
        params: {
          attemptId,
          outcome,
          resultSummary: resultSummary ?? null,
          completedAt: new Date().toISOString(),
        },
      },
    );
    const row = await queryOne(
      graph,
      `MATCH (a:DebugAttempt {id: $attemptId})
       RETURN a.outcome AS outcome, a.resultSummary AS resultSummary`,
      { attemptId },
      "attempt outcome lookup",
    );
    if (
      stringField(row, "outcome") !== outcome
      || !sameOptional(optionalStringField(row, "resultSummary"), resultSummary)
    ) {
      throw new Error(`Attempt "${attemptId}" already has a conflicting outcome`);
    }
  } finally {
    await db.close();
  }
}

export async function recordPatch(input: PatchInput): Promise<DebugPatch> {
  requireText(input.attemptId, "attemptId");
  requireText(input.patchHash, "patchHash");
  requireText(input.status, "status");
  const id = stableId("patch", input.patchHash);
  const createdAt = new Date().toISOString();
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const existing = await graph.roQuery<QueryRow>(
      `
        MATCH (p:Patch {id: $id})
        RETURN p.patchHash AS patchHash, p.diffSummary AS diffSummary,
               p.diffRef AS diffRef
      `,
      { params: { id } },
    );
    const existingRow = rowsOf(existing.data, "patch identity lookup")[0];
    if (existingRow !== undefined && (
      stringField(existingRow, "patchHash") !== input.patchHash
      || !sameOptional(optionalStringField(existingRow, "diffSummary"), input.diffSummary)
      || !sameOptional(optionalStringField(existingRow, "diffRef"), input.diffRef)
    )) {
      throw new Error(`Patch "${id}" already exists with conflicting immutable metadata`);
    }
    await graph.query(
      `
        MATCH (a:DebugAttempt {id: $attemptId})
        MERGE (p:Patch {id: $id})
        ON CREATE SET p.patchHash = $patchHash,
                      p.status = $status,
                      p.diffSummary = $diffSummary,
                      p.diffRef = $diffRef,
                      p.createdAt = $createdAt
        MERGE (a)-[r:APPLIES]->(p)
        ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'manual'
      `,
      {
        params: {
          attemptId: input.attemptId,
          id,
          patchHash: input.patchHash,
          status: input.status,
          diffSummary: input.diffSummary ?? null,
          diffRef: input.diffRef ?? null,
          createdAt,
        },
      },
    );
    if (input.hypothesisId !== undefined) {
      await graph.query(
        `
          MATCH (h:Hypothesis {id: $hypothesisId}), (p:Patch {id: $patchId})
          MERGE (h)-[r:HAS_PATCH]->(p)
          ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'manual'
        `,
        { params: { hypothesisId: input.hypothesisId, patchId: id, createdAt } },
      );
    }
    const persisted = await queryOne(
      graph,
      `
        MATCH (p:Patch {id: $id})
        RETURN p.patchHash AS patchHash, p.status AS status,
               p.diffSummary AS diffSummary, p.diffRef AS diffRef,
               p.createdAt AS createdAt
      `,
      { id },
      "patch persistence lookup",
    );
    return {
      ...input,
      id,
      patchHash: stringField(persisted, "patchHash"),
      status: stringField(persisted, "status"),
      diffSummary: optionalStringField(persisted, "diffSummary"),
      diffRef: optionalStringField(persisted, "diffRef"),
      createdAt: stringField(persisted, "createdAt"),
    };
  } finally {
    await db.close();
  }
}

export async function recordEvidence(input: EvidenceInput): Promise<DebugEvidence> {
  requireText(input.attemptId, "attemptId");
  requireText(input.kind, "kind");
  requireText(input.result, "result");
  requireText(input.summary, "summary");
  requireText(input.sourceKind, "sourceKind");
  const relationToHypothesis = evidenceRelation(input.relationToHypothesis);
  const observedAt = new Date().toISOString();
  const id = stableId("evidence", `${input.attemptId}:${input.kind}:${input.sourceRef ?? input.summary}`);
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const existing = await graph.roQuery<QueryRow>(
      `
        MATCH (e:Evidence {id: $id})
        RETURN e.kind AS kind, e.result AS result, e.summary AS summary,
               e.sourceKind AS sourceKind, e.sourceRef AS sourceRef,
               e.rawRef AS rawRef, e.testName AS testName, e.exitCode AS exitCode
      `,
      { params: { id } },
    );
    const existingRow = rowsOf(existing.data, "evidence identity lookup")[0];
    if (existingRow !== undefined && (
      stringField(existingRow, "kind") !== input.kind
      || stringField(existingRow, "result") !== input.result
      || stringField(existingRow, "summary") !== input.summary
      || stringField(existingRow, "sourceKind") !== input.sourceKind
      || !sameOptional(optionalStringField(existingRow, "sourceRef"), input.sourceRef)
      || !sameOptional(optionalStringField(existingRow, "rawRef"), input.rawRef)
      || !sameOptional(optionalStringField(existingRow, "testName"), input.testName)
      || optionalNumberField(existingRow, "exitCode") !== input.exitCode
    )) {
      throw new Error(`Evidence "${id}" already exists with conflicting content`);
    }
    await graph.query(
      `
        MATCH (a:DebugAttempt {id: $attemptId})
        MERGE (e:Evidence {id: $id})
        ON CREATE SET e.kind = $kind,
                      e.result = $result,
                      e.summary = $summary,
                      e.sourceKind = $sourceKind,
                      e.sourceRef = $sourceRef,
                      e.observedAt = $observedAt,
                      e.collectedAt = $observedAt,
                      e.rawRef = $rawRef,
                      e.testName = $testName,
                      e.exitCode = $exitCode
        MERGE (a)-[r:HAS_EVIDENCE]->(e)
        ON CREATE SET r.createdAt = $observedAt, r.sourceKind = $sourceKind
      `,
      {
        params: {
          attemptId: input.attemptId,
          id,
          kind: input.kind,
          result: input.result,
          summary: input.summary,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef ?? null,
          observedAt,
          rawRef: input.rawRef ?? null,
          testName: input.testName ?? null,
          exitCode: input.exitCode ?? null,
        },
      },
    );
    const existingRelation = await graph.roQuery<QueryRow>(
      `
        MATCH (e:Evidence {id: $evidenceId})-[r]->(h:Hypothesis)
        WHERE type(r) IN ['SUPPORTS', 'CONTRADICTS', 'VALIDATES']
        RETURN h.id AS hypothesisId, type(r) AS relationType
      `,
      { params: { evidenceId: id } },
    );
    const relationRow = rowsOf(existingRelation.data, "evidence relation lookup")[0];
    if (
      relationRow !== undefined
      && (
        input.hypothesisId === undefined
        || relationToHypothesis === undefined
        || stringField(relationRow, "hypothesisId") !== input.hypothesisId
        || stringField(relationRow, "relationType") !== relationToHypothesis
      )
    ) {
      throw new Error(`Evidence "${id}" already has a conflicting hypothesis relation`);
    }
    if (input.hypothesisId !== undefined && relationToHypothesis !== undefined) {
      await graph.query(
        `
          MATCH (e:Evidence {id: $evidenceId}), (h:Hypothesis {id: $hypothesisId})
          MERGE (e)-[r:${relationToHypothesis}]->(h)
          ON CREATE SET r.createdAt = $createdAt, r.sourceKind = $sourceKind
        `,
        { params: { evidenceId: id, hypothesisId: input.hypothesisId, createdAt: observedAt, sourceKind: input.sourceKind } },
      );
    }
    const persisted = await queryOne(
      graph,
      `
        MATCH (e:Evidence {id: $id})
        RETURN e.kind AS kind, e.result AS result, e.summary AS summary,
               e.sourceKind AS sourceKind, e.sourceRef AS sourceRef,
               e.observedAt AS observedAt, e.collectedAt AS collectedAt,
               e.rawRef AS rawRef, e.testName AS testName, e.exitCode AS exitCode
      `,
      { id },
      "evidence persistence lookup",
    );
    return {
      ...input,
      id,
      kind: stringField(persisted, "kind"),
      result: stringField(persisted, "result"),
      summary: stringField(persisted, "summary"),
      sourceKind: stringField(persisted, "sourceKind"),
      sourceRef: optionalStringField(persisted, "sourceRef"),
      observedAt: stringField(persisted, "observedAt"),
      collectedAt: stringField(persisted, "collectedAt"),
      rawRef: optionalStringField(persisted, "rawRef"),
      testName: optionalStringField(persisted, "testName"),
      exitCode: optionalNumberField(persisted, "exitCode"),
    };
  } finally {
    await db.close();
  }
}

export async function retrieveDebugHistory(
  sessionId: string,
  maxAttempts = MAX_ATTEMPTS,
): Promise<HistoryRecord> {
  requireText(sessionId, "sessionId");
  requirePositiveInteger(maxAttempts, "maxAttempts");
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const sessionRow = await queryOne(
      graph,
      `
        MATCH (s:Session {id: $sessionId})
        OPTIONAL MATCH (s)-[:TARGETS]->(d:Diagnostic)
        RETURN s.id AS id, s.goal AS goal, s.status AS status,
               s.startedAt AS startedAt, s.baselineRevision AS baselineRevision,
               d.id AS diagnosticId
        LIMIT 1
      `,
      { sessionId },
      "history session lookup",
    );
    const session: DebugSession = {
      id: stringField(sessionRow, "id"),
      goal: stringField(sessionRow, "goal"),
      status: stringField(sessionRow, "status"),
      startedAt: stringField(sessionRow, "startedAt"),
      ...(optionalStringField(sessionRow, "baselineRevision") === undefined
        ? {} : { baselineRevision: optionalStringField(sessionRow, "baselineRevision") }),
      ...(optionalStringField(sessionRow, "diagnosticId") === undefined
        ? {} : { diagnosticId: optionalStringField(sessionRow, "diagnosticId") }),
    };
    const hypothesisRows = rowsOf((await graph.roQuery<QueryRow>(
      `
        MATCH (s:Session {id: $sessionId})-[:HAS_HYPOTHESIS]->(h:Hypothesis)
        RETURN h.id AS id, h.statement AS statement, h.rootCauseCategory AS rootCauseCategory,
               h.status AS status, h.provenanceKind AS provenanceKind,
               h.rationale AS rationale, h.hypothesisFingerprint AS hypothesisFingerprint
        ORDER BY h.createdAt, h.id
        LIMIT $limit
      `,
      { params: { sessionId, limit: MAX_HYPOTHESES } },
    )).data, "history hypothesis lookup");
    const hypotheses = hypothesisRows.map((row) => ({
      id: stringField(row, "id"),
      sessionId,
      statement: stringField(row, "statement"),
      rootCauseCategory: optionalStringField(row, "rootCauseCategory"),
      status: stringField(row, "status"),
      provenanceKind: stringField(row, "provenanceKind"),
      rationale: optionalStringField(row, "rationale"),
      hypothesisFingerprint: stringField(row, "hypothesisFingerprint"),
    }));
    const attemptRows = rowsOf((await graph.roQuery<QueryRow>(
      `
        MATCH (s:Session {id: $sessionId})-[:HAS_ATTEMPT]->(a:DebugAttempt)
        RETURN a.id AS id, a.sequenceNo AS sequenceNo, a.status AS status,
               a.startedAt AS startedAt, a.completedAt AS completedAt,
               a.outcome AS outcome, a.resultSummary AS resultSummary,
               a.testCommand AS testCommand
        ORDER BY a.sequenceNo, a.startedAt, a.id
        LIMIT $limit
      `,
      { params: { sessionId, limit: maxAttempts } },
    )).data, "history attempt lookup");
    const attempts = attemptRows.map((row) => ({
      id: stringField(row, "id"),
      sessionId,
      sequenceNo: numberField(row, "sequenceNo"),
      status: attemptStatus(stringField(row, "status")),
      startedAt: stringField(row, "startedAt"),
      ...(optionalStringField(row, "completedAt") === undefined ? {} : { completedAt: optionalStringField(row, "completedAt") }),
      ...(optionalStringField(row, "outcome") === undefined ? {} : { outcome: optionalStringField(row, "outcome") as AttemptOutcome }),
      ...(optionalStringField(row, "resultSummary") === undefined ? {} : { resultSummary: optionalStringField(row, "resultSummary") }),
      ...(optionalStringField(row, "testCommand") === undefined ? {} : { testCommand: optionalStringField(row, "testCommand") }),
    }));
    const attemptIds = attempts.map((attempt) => attempt.id);
    const patches = attemptIds.length === 0 ? [] : rowsOf((await graph.roQuery<QueryRow>(
      `
        MATCH (a:DebugAttempt)-[:APPLIES]->(p:Patch)
        WHERE a.id IN $attemptIds
        RETURN p.id AS id, a.id AS attemptId, p.patchHash AS patchHash,
               p.status AS status, p.diffSummary AS diffSummary,
               p.diffRef AS diffRef, p.createdAt AS createdAt
        ORDER BY p.createdAt, p.id
        LIMIT $limit
      `,
      { params: { attemptIds, limit: MAX_PATCHES } },
    )).data, "history patch lookup").map((row) => ({
      id: stringField(row, "id"),
      attemptId: stringField(row, "attemptId"),
      patchHash: stringField(row, "patchHash"),
      status: stringField(row, "status"),
      diffSummary: optionalStringField(row, "diffSummary"),
      diffRef: optionalStringField(row, "diffRef"),
      createdAt: stringField(row, "createdAt"),
    }));
    const evidence = attemptIds.length === 0 ? [] : rowsOf((await graph.roQuery<QueryRow>(
      `
        MATCH (a:DebugAttempt)-[:HAS_EVIDENCE]->(e:Evidence)
        WHERE a.id IN $attemptIds
        RETURN e.id AS id, a.id AS attemptId, e.kind AS kind,
               e.result AS result, e.summary AS summary, e.sourceKind AS sourceKind,
               e.sourceRef AS sourceRef, e.observedAt AS observedAt,
               e.collectedAt AS collectedAt, e.rawRef AS rawRef,
               e.testName AS testName, e.exitCode AS exitCode
        ORDER BY e.observedAt, e.id
        LIMIT $limit
      `,
      { params: { attemptIds, limit: MAX_EVIDENCE } },
    )).data, "history evidence lookup").map((row) => ({
      id: stringField(row, "id"),
      attemptId: stringField(row, "attemptId"),
      kind: stringField(row, "kind"),
      result: stringField(row, "result"),
      summary: stringField(row, "summary"),
      sourceKind: stringField(row, "sourceKind"),
      sourceRef: optionalStringField(row, "sourceRef"),
      observedAt: stringField(row, "observedAt"),
      collectedAt: stringField(row, "collectedAt"),
      rawRef: optionalStringField(row, "rawRef"),
      testName: optionalStringField(row, "testName"),
      exitCode: optionalNumberField(row, "exitCode"),
    }));
    const relationships = rowsOf((await graph.roQuery<QueryRow>(
      `
        MATCH (s:Session {id: $sessionId})-[r]->(target)
        WHERE type(r) IN ['TARGETS', 'HAS_HYPOTHESIS', 'HAS_ATTEMPT']
        RETURN type(r) AS type, s.id AS fromId, target.id AS toId
        UNION
        MATCH (source)-[r]->(target)
        WHERE source.id IN $historyIds AND type(r) IN
          ['TESTED_BY', 'FOLLOWS', 'APPLIES', 'HAS_EVIDENCE',
           'HAS_PATCH', 'SUPPORTS', 'CONTRADICTS', 'VALIDATES']
        RETURN type(r) AS type, source.id AS fromId, target.id AS toId
      `,
      { params: { sessionId, historyIds: [...attemptIds, ...hypotheses.map((h) => h.id), ...patches.map((p) => p.id), ...evidence.map((e) => e.id)] } },
    )).data, "history relationship lookup").map((row) => ({
      type: stringField(row, "type") as HistoryRecord["relationships"][number]["type"],
      fromId: stringField(row, "fromId"),
      toId: stringField(row, "toId"),
    }));
    return {
      session,
      hypothesis: hypotheses,
      attempts,
      patches,
      evidence,
      outcomes: attempts.flatMap((attempt) => attempt.outcome === undefined ? [] : [{
        attemptId: attempt.id,
        status: attempt.status,
        outcome: attempt.outcome,
        ...(attempt.resultSummary === undefined ? {} : { resultSummary: attempt.resultSummary }),
      }]),
      relationships,
      metadata: {
        graphName,
        counts: {
          hypotheses: hypotheses.length,
          attempts: attempts.length,
          patches: patches.length,
          evidence: evidence.length,
        },
        maxAttempts,
      },
    };
  } finally {
    await db.close();
  }
}
