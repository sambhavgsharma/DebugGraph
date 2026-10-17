import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FalkorDB } from "falkordb";
import {
  createMcpServer,
  type AssembleDebugContext,
} from "../src/mcp-server";
import {
  deriveRecommendations,
  type AssembledDebugContext,
} from "../src/debugging/context-assembler";
import {
  createOrReuseDebugSession,
  retrieveDebugHistoriesForDiagnostic,
  retrieveDebugHistory,
  type HistoryRecord,
} from "../src/debugging/history";
import {
  listLatestCompilerDiagnostics,
} from "../src/diagnostics/diagnostic-ingest";
import type { DiagnosticContext } from "../src/debugging/context-retrieval";

const diagnosticId = "diagnostic-1";
const evidenceId = "evidence-project-tsc";
const hypothesisId = "hypothesis-project-tsc";
const attemptId = "attempt-project-tsc";
const projectSessionId = "project-verification-session";
const targetedSessionId = "diagnostic-session";

type StoredSession = {
  readonly id: string;
  readonly goal: string;
  readonly status: string;
  readonly startedAt: string;
  readonly baselineRevision?: string;
  readonly diagnosticId?: string;
};

type StoredHistory = {
  readonly session: StoredSession;
  readonly hypotheses: readonly Record<string, unknown>[];
  readonly attempts: readonly Record<string, unknown>[];
  readonly patches: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
  readonly relationships: readonly Record<string, unknown>[];
};

const projectHistory: StoredHistory = {
  session: {
    id: projectSessionId,
    goal: "Verify project compilation",
    status: "completed",
    startedAt: "2026-10-16T17:09:00.000Z",
    baselineRevision: "project-baseline",
  },
  hypotheses: [{
    id: hypothesisId,
    statement: "The project passes the TypeScript compiler check.",
    status: "proposed",
    provenanceKind: "compiler-verification",
    hypothesisFingerprint: "project-hypothesis-fingerprint",
  }],
  attempts: [{
    id: attemptId,
    sequenceNo: 1,
    status: "completed",
    startedAt: "2026-10-16T17:09:20.000Z",
    completedAt: "2026-10-16T17:09:21.305Z",
    outcome: "successful",
    resultSummary: "The compiler completed successfully.",
    testCommand: "npx tsc --noEmit",
  }],
  patches: [],
  evidence: [{
    id: evidenceId,
    attemptId,
    kind: "compiler_verification",
    result: "passed",
    summary: "npx tsc --noEmit completed successfully.",
    sourceKind: "compiler",
    sourceRef: "project-verification-source",
    rawRef: "run:project-verification",
    testName: "npx tsc --noEmit",
    exitCode: 0,
    observedAt: "2026-10-16T17:09:21.305Z",
    collectedAt: "2026-10-16T17:09:21.305Z",
  }],
  relationships: [
    { type: "HAS_ATTEMPT", fromId: projectSessionId, toId: attemptId },
    { type: "HAS_EVIDENCE", fromId: attemptId, toId: evidenceId },
    { type: "CONTRADICTS", fromId: evidenceId, toId: hypothesisId },
  ],
};

const diagnosticContext: DiagnosticContext = {
  diagnostic: {
    id: diagnosticId,
    severity: "error",
    code: 2322,
    message: "Type is not assignable",
  },
  items: [],
  relationships: [],
  metadata: {
    graphName: "DebugGraphDev",
    diagnosticId,
    counts: { items: 0, files: 0, symbols: 0, relationships: 0 },
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

class IsolatedGraph {
  readonly sessions = new Map<string, StoredSession>();
  readonly histories = new Map<string, StoredHistory>();
  readonly targets = new Map<string, string>();
  latestDiagnostics: readonly Record<string, unknown>[] = [];
  latestScanId = "scan-latest";

  async query(query: string, options?: { params?: Record<string, unknown> }): Promise<void> {
    const params = options?.params ?? {};
    if (query.includes("MERGE (s:Session {id: $sessionId})")) {
      const id = String(params.sessionId);
      const existing = this.sessions.get(id);
      this.sessions.set(id, {
        id,
        goal: existing?.goal ?? String(params.goal),
        status: existing?.status ?? "active",
        startedAt: existing?.startedAt ?? String(params.startedAt),
        ...(params.baselineRevision ? { baselineRevision: String(params.baselineRevision) } : {}),
        ...(existing?.diagnosticId ? { diagnosticId: existing.diagnosticId } : {}),
      });
    }
    if (query.includes("TARGETS") && params.diagnosticId !== undefined) {
      const sessionId = String(params.sessionId);
      const diagnostic = String(params.diagnosticId);
      this.targets.set(sessionId, diagnostic);
      const session = this.sessions.get(sessionId);
      if (session) this.sessions.set(sessionId, { ...session, diagnosticId: diagnostic });
    }
  }

  async roQuery<T>(query: string, options?: { params?: Record<string, unknown> }): Promise<{ data: T[] }> {
    const params = options?.params ?? {};
    if (query.includes("MATCH (s:Session {id: $sessionId})")
      && query.includes("OPTIONAL MATCH (s)-[:TARGETS]")) {
      const session = this.sessions.get(String(params.sessionId));
      return { data: session ? [session] as T[] : [] };
    }
    if (query.includes("MATCH (session:Session)-[:TARGETS]")
      && params.diagnosticId !== undefined) {
      return {
        data: [...this.targets.entries()]
          .filter(([, id]) => id === params.diagnosticId)
          .map(([sessionId]) => ({ sessionId })) as T[],
      };
    }
    if (query.includes("WHERE session.goal = 'compiler diagnostic scan'")) {
      return { data: [{ sessionId: this.latestScanId }] as T[] };
    }
    if (query.includes("MATCH (session:Session {id: $sessionId})-[:TARGETS]->(diagnostic:Diagnostic)")) {
      return { data: this.latestDiagnostics as T[] };
    }

    const sessionId = String(params.sessionId);
    const attemptIds = Array.isArray(params.attemptIds) ? params.attemptIds.map(String) : [];
    const history = this.histories.get(sessionId)
      ?? [...this.histories.values()].find((candidate) =>
        candidate.attempts.some((attempt) => attemptIds.includes(String(attempt.id))));
    if (query.includes("type(r) IN")) return { data: (history?.relationships ?? []) as T[] };
    if (query.includes("HAS_HYPOTHESIS")) return { data: (history?.hypotheses ?? []) as T[] };
    if (query.includes("HAS_ATTEMPT")) return { data: (history?.attempts ?? []) as T[] };
    if (query.includes("APPLIES")) return { data: (history?.patches ?? []) as T[] };
    if (query.includes("HAS_EVIDENCE")) return { data: (history?.evidence ?? []) as T[] };
    return { data: [] };
  }

  selectGraph(): this {
    return this;
  }

  async close(): Promise<void> {}

  connectionFactory(): () => Promise<FalkorDB> {
    return async () => this as unknown as FalkorDB;
  }
}

function seedGraph(): IsolatedGraph {
  const graph = new IsolatedGraph();
  graph.sessions.set(projectSessionId, projectHistory.session);
  graph.sessions.set(targetedSessionId, {
    ...projectHistory.session,
    id: targetedSessionId,
    diagnosticId,
  });
  graph.targets.set(targetedSessionId, diagnosticId);
  graph.histories.set(projectSessionId, projectHistory);
  graph.histories.set(targetedSessionId, {
    ...projectHistory,
    session: { ...projectHistory.session, id: targetedSessionId, diagnosticId },
  });
  return graph;
}

function assembledWith(histories: readonly HistoryRecord[]): AssembledDebugContext {
  return {
    diagnostic: diagnosticContext.diagnostic,
    codeContext: diagnosticContext,
    historicalSessions: histories,
    facts: histories.flatMap((history) => history.evidence.map((evidence) => ({
      id: `evidence:${evidence.id}`,
      category: "historical" as const,
      statement: evidence.summary,
      sourceIds: [history.session.id, evidence.id],
      observed: "direct" as const,
    }))),
    hypotheses: histories.flatMap((history) => history.hypothesis),
    outcomes: histories.flatMap((history) => history.outcomes),
    evidence: histories.flatMap((history) => history.evidence),
    recommendations: [],
    metadata: {
      graphName: "DebugGraphDev",
      diagnosticId,
      limits: { maxSessions: 20, maxAttemptsPerSession: 100 },
    },
  };
}

async function connectedServer(assemble: AssembleDebugContext) {
  const server = createMcpServer(assemble);
  const client = new Client({ name: "phase6b-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("session recording creates TARGETS only when a diagnostic is supplied", async () => {
  const graph = new IsolatedGraph();
  await createOrReuseDebugSession({
    sessionId: "project-session",
    goal: "Project verification",
  }, graph.connectionFactory());
  await createOrReuseDebugSession({
    sessionId: "targeted-session",
    diagnosticId,
    goal: "Fix diagnostic",
  }, graph.connectionFactory());

  assert.equal(graph.targets.has("project-session"), false);
  assert.equal(graph.targets.get("targeted-session"), diagnosticId);
});

test("diagnostic history retrieval excludes sessions without TARGETS", async () => {
  const graph = seedGraph();
  const histories = await retrieveDebugHistoriesForDiagnostic(
    diagnosticId,
    20,
    100,
    graph.connectionFactory(),
  );

  assert.deepEqual(histories.map((history) => history.session.id), [targetedSessionId]);
});

test("project history retrieval preserves evidence and CONTRADICTS relationships", async () => {
  const graph = seedGraph();
  const history = await retrieveDebugHistory(projectSessionId, 100, graph.connectionFactory());

  assert.equal(history.evidence[0].sourceRef, "project-verification-source");
  assert.equal(history.evidence[0].exitCode, 0);
  assert.deepEqual(
    history.relationships.filter((relationship) =>
      relationship.fromId === evidenceId || relationship.toId === evidenceId),
    [
      { type: "HAS_EVIDENCE", fromId: attemptId, toId: evidenceId },
      { type: "CONTRADICTS", fromId: evidenceId, toId: hypothesisId },
    ],
  );
});

test("successful standalone compiler evidence does not resolve the diagnostic", async () => {
  const graph = seedGraph();
  const history = await retrieveDebugHistory(projectSessionId, 100, graph.connectionFactory());
  const recommendations = deriveRecommendations(diagnosticContext, [history]);

  assert.equal(
    recommendations.some((recommendation) => recommendation.reason.toLowerCase().includes("resolved")),
    false,
  );
});

test("latest scan omits absent diagnostics while preserving historical data", async () => {
  const graph = seedGraph();
  graph.latestDiagnostics = [{
    sessionId: graph.latestScanId,
    severity: "error",
    code: 7001,
    message: "A different latest diagnostic",
    filePath: "src/current.ts",
    lineNumber: 1,
    columnNumber: 1,
  }];

  const latest = await listLatestCompilerDiagnostics(".", graph.connectionFactory());
  const historical = await retrieveDebugHistory(projectSessionId, 100, graph.connectionFactory());

  assert.equal(latest.some((diagnostic) => diagnostic.message === "Type is not assignable"), false);
  assert.equal(historical.evidence[0].id, evidenceId);
});

test("MCP preserves retrieved evidence and CONTRADICTS relationships", async () => {
  const graph = seedGraph();
  const history = await retrieveDebugHistory(projectSessionId, 100, graph.connectionFactory());
  const assembled = assembledWith([history]);
  const { server, client } = await connectedServer(async () => assembled);
  try {
    const result = await client.callTool({
      name: "debuggraph_investigate",
      arguments: { diagnosticId },
    });
    assert.equal(result.isError, undefined);
    const returned = JSON.parse((result.content[0] as { text: string }).text) as AssembledDebugContext;
    assert.deepEqual(returned.evidence[0], history.evidence[0]);
    assert.ok(returned.historicalSessions[0].relationships.some((relationship) =>
      relationship.type === "CONTRADICTS"
      && relationship.fromId === evidenceId
      && relationship.toId === hypothesisId));
  } finally {
    await client.close();
    await server.close();
  }
});
