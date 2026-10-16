import { resolve } from "node:path";
import { connectToGraph, graphName } from "../graph/client";
import {
  DEFAULT_CONTEXT_LIMITS,
  validateContextLimits,
} from "./limits";

type QueryRow = Readonly<Record<string, unknown>>;

export type ContextRetrievalLimits = {
  readonly maxDiagnostics?: number;
  readonly maxFileSymbols?: number;
  readonly maxImportedFiles?: number;
  readonly maxImportedFileSymbols?: number;
  readonly maxCallers?: number;
  readonly maxCallees?: number;
};

export type DiagnosticContextItem = {
  readonly id: string;
  readonly kind: "file" | "symbol";
  readonly filePath?: string;
  readonly name?: string;
  readonly qualifiedName?: string;
  readonly symbolKind?: string;
  readonly lineNumber?: number;
  readonly endLineNumber?: number;
  readonly language?: string;
  readonly provenance: {
    readonly reason: string;
    readonly relationship?: string;
    readonly observed: "direct" | "inferred";
  };
};

export type DiagnosticContextRelationship = {
  readonly type: "CONTAINS" | "IMPORTS" | "CALLS" | "LOCATED_IN";
  readonly direction: "incoming" | "outgoing";
  readonly fromId: string;
  readonly toId: string;
  readonly sourceKind?: string;
  readonly observed: "direct" | "inferred";
  readonly reason: string;
};

export type DiagnosticContext = {
  readonly diagnostic: {
    readonly id: string;
    readonly severity: string;
    readonly code: number;
    readonly message: string;
    readonly filePath?: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
  };
  readonly items: readonly DiagnosticContextItem[];
  readonly relationships: readonly DiagnosticContextRelationship[];
  readonly metadata: {
    readonly graphName: string;
    readonly diagnosticId: string;
    readonly counts: {
      readonly items: number;
      readonly files: number;
      readonly symbols: number;
      readonly relationships: number;
    };
    readonly limits: Required<ContextRetrievalLimits>;
  };
};

function limitsOf(value: ContextRetrievalLimits = {}): Required<ContextRetrievalLimits> {
  return validateContextLimits(value);
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(row: QueryRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Context query result field "${field}" was not a string`);
  }
  return value;
}

function optionalString(row: QueryRow, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Context query result field "${field}" was not a string or null`);
  }
  return value;
}

function requiredNumber(row: QueryRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Context query result field "${field}" was not a finite number`);
  }
  return value;
}

function optionalNumber(row: QueryRow, field: string): number | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Context query result field "${field}" was not a finite number or null`);
  }
  return value;
}

function rowsOf(data: readonly unknown[] | undefined, queryName: string): readonly QueryRow[] {
  return (data ?? []).map((value, index) => {
    if (!isQueryRow(value)) {
      throw new Error(`${queryName} returned an unexpected row at index ${index}`);
    }
    return value;
  });
}

function itemForFile(row: QueryRow, reason: string): DiagnosticContextItem {
  return {
    id: requiredString(row, "id"),
    kind: "file",
    filePath: requiredString(row, "filePath"),
    language: optionalString(row, "language"),
    provenance: { reason, relationship: "LOCATED_IN", observed: "direct" },
  };
}

function itemForSymbol(
  row: QueryRow,
  reason: string,
  observed: "direct" | "inferred" = "direct",
  relationshipType: "CONTAINS" | "LOCATED_IN" = "CONTAINS",
): DiagnosticContextItem {
  return {
    id: requiredString(row, "id"),
    kind: "symbol",
    name: optionalString(row, "name"),
    qualifiedName: optionalString(row, "qualifiedName"),
    symbolKind: optionalString(row, "kind"),
    filePath: optionalString(row, "filePath"),
    lineNumber: optionalNumber(row, "lineNumber"),
    endLineNumber: optionalNumber(row, "endLineNumber"),
    language: optionalString(row, "language"),
    provenance: { reason, relationship: relationshipType, observed },
  };
}

function relationship(
  row: QueryRow,
  type: DiagnosticContextRelationship["type"],
  direction: DiagnosticContextRelationship["direction"],
  reason: string,
  observed: "direct" | "inferred" = "direct",
): DiagnosticContextRelationship {
  return {
    type,
    direction,
    fromId: requiredString(row, "fromId"),
    toId: requiredString(row, "toId"),
    sourceKind: optionalString(row, "sourceKind"),
    observed,
    reason,
  };
}

function deduplicateItems(items: readonly DiagnosticContextItem[]): readonly DiagnosticContextItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateRelationships(
  relationships: readonly DiagnosticContextRelationship[],
): readonly DiagnosticContextRelationship[] {
  const seen = new Set<string>();
  return relationships.filter((item) => {
    const key = `${item.type}:${item.direction}:${item.fromId}:${item.toId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function retrieveOnGraph(
  graph: import("falkordb").Graph,
  diagnosticId: string,
  limits: Required<ContextRetrievalLimits>,
): Promise<DiagnosticContext> {
  const diagnosticResult = await graph.roQuery<QueryRow>(
    `
      MATCH (d:Diagnostic {id: $diagnosticId})
      RETURN d.id AS id, d.severity AS severity, d.code AS code,
             d.message AS message, d.filePath AS filePath,
             d.lineNumber AS lineNumber, d.columnNumber AS columnNumber
    `,
    { params: { diagnosticId } },
  );
  const diagnosticRows = rowsOf(diagnosticResult.data, "diagnostic lookup");
  if (diagnosticRows.length !== 1) {
    throw new Error(`Diagnostic "${diagnosticId}" was not found`);
  }
  const diagnosticRow = diagnosticRows[0];
  const diagnostic = {
    id: requiredString(diagnosticRow, "id"),
    severity: requiredString(diagnosticRow, "severity"),
    code: requiredNumber(diagnosticRow, "code"),
    message: requiredString(diagnosticRow, "message"),
    filePath: optionalString(diagnosticRow, "filePath"),
    lineNumber: optionalNumber(diagnosticRow, "lineNumber"),
    columnNumber: optionalNumber(diagnosticRow, "columnNumber"),
  };

  const items: DiagnosticContextItem[] = [];
  const relationships: DiagnosticContextRelationship[] = [];
  const locatedResult = await graph.roQuery<QueryRow>(
    `
      MATCH (d:Diagnostic {id: $diagnosticId})-[r:LOCATED_IN]->(f:File)
      RETURN f.id AS id, f.filePath AS filePath, f.language AS language,
             d.id AS fromId, f.id AS toId, r.sourceKind AS sourceKind
    `,
    { params: { diagnosticId } },
  );
  const locatedRows = rowsOf(locatedResult.data, "diagnostic file lookup");
  for (const row of locatedRows.slice(0, 1)) {
    items.push(itemForFile(row, "diagnostic source file"));
    relationships.push(relationship(row, "LOCATED_IN", "outgoing", "diagnostic is located in this file"));
  }

  const symbolResult = await graph.roQuery<QueryRow>(
    `
      MATCH (d:Diagnostic {id: $diagnosticId})-[r:LOCATED_IN]->(s:Symbol)
      RETURN s.id AS id, s.name AS name, s.qualifiedName AS qualifiedName,
             s.kind AS kind, s.filePath AS filePath, s.lineNumber AS lineNumber,
             s.endLineNumber AS endLineNumber, s.language AS language,
             d.id AS fromId, s.id AS toId, r.sourceKind AS sourceKind
    `,
    { params: { diagnosticId } },
  );
  const symbolRows = rowsOf(symbolResult.data, "diagnostic symbol lookup");
  for (const row of symbolRows.slice(0, 1)) {
    items.push(itemForSymbol(
      row,
      "containing symbol inferred from diagnostic position",
      "inferred",
      "LOCATED_IN",
    ));
    relationships.push(relationship(
      row,
      "LOCATED_IN",
      "outgoing",
      "diagnostic is associated with this containing symbol",
      "inferred",
    ));
  }

  const file = items.find((item) => item.kind === "file");
  if (file !== undefined) {
    const fileSymbols = await graph.roQuery<QueryRow>(
      `
        MATCH (f:File {id: $fileId})-[r:CONTAINS]->(s:Symbol)
        RETURN s.id AS id, s.name AS name, s.qualifiedName AS qualifiedName,
               s.kind AS kind, s.filePath AS filePath, s.lineNumber AS lineNumber,
               s.endLineNumber AS endLineNumber, s.language AS language,
               f.id AS fromId, s.id AS toId, r.sourceKind AS sourceKind
        ORDER BY s.lineNumber, s.endLineNumber, s.id
        LIMIT $limit
      `,
      { params: { fileId: file.id, limit: limits.maxFileSymbols } },
    );
    for (const row of rowsOf(fileSymbols.data, "file symbol lookup")) {
      items.push(itemForSymbol(row, "symbol declared in diagnostic file"));
      relationships.push(relationship(row, "CONTAINS", "outgoing", "file contains this symbol"));
    }

    const imports = await graph.roQuery<QueryRow>(
      `
        MATCH (f:File {id: $fileId})-[r:IMPORTS]->(target:File)
        RETURN target.id AS id, target.filePath AS filePath,
               target.language AS language, f.id AS fromId,
               target.id AS toId, r.sourceKind AS sourceKind
        ORDER BY target.filePath, target.id
        LIMIT $limit
      `,
      { params: { fileId: file.id, limit: limits.maxImportedFiles } },
    );
    for (const row of rowsOf(imports.data, "import lookup")) {
      const importedFileId = requiredString(row, "id");
      items.push(itemForFile(row, "file locally imported by diagnostic file"));
      relationships.push(relationship(row, "IMPORTS", "outgoing", "diagnostic file imports this local file"));

      const importedSymbols = await graph.roQuery<QueryRow>(
        `
          MATCH (f:File {id: $fileId})-[r:CONTAINS]->(s:Symbol)
          RETURN s.id AS id, s.name AS name, s.qualifiedName AS qualifiedName,
                 s.kind AS kind, s.filePath AS filePath, s.lineNumber AS lineNumber,
                 s.endLineNumber AS endLineNumber, s.language AS language,
                 f.id AS fromId, s.id AS toId, r.sourceKind AS sourceKind
          ORDER BY s.lineNumber, s.endLineNumber, s.id
          LIMIT $limit
        `,
        { params: { fileId: importedFileId, limit: limits.maxImportedFileSymbols } },
      );
      for (const symbolRow of rowsOf(importedSymbols.data, "imported file symbol lookup")) {
        items.push(itemForSymbol(symbolRow, "symbol declared in a locally imported file"));
        relationships.push(relationship(symbolRow, "CONTAINS", "outgoing", "imported file contains this symbol"));
      }
    }
  }

  const containingSymbol = items.find((item) =>
    item.kind === "symbol" && item.provenance.reason.includes("containing symbol"),
  );
  if (containingSymbol !== undefined) {
    const [callers, callees] = await Promise.all([
      graph.roQuery<QueryRow>(
        `
          MATCH (caller:Symbol)-[r:CALLS]->(callee:Symbol {id: $symbolId})
          RETURN caller.id AS fromId, callee.id AS toId,
                 r.sourceKind AS sourceKind
          ORDER BY caller.id
          LIMIT $limit
        `,
        { params: { symbolId: containingSymbol.id, limit: limits.maxCallers } },
      ),
      graph.roQuery<QueryRow>(
        `
          MATCH (caller:Symbol {id: $symbolId})-[r:CALLS]->(callee:Symbol)
          RETURN caller.id AS fromId, callee.id AS toId,
                 r.sourceKind AS sourceKind
          ORDER BY callee.id
          LIMIT $limit
        `,
        { params: { symbolId: containingSymbol.id, limit: limits.maxCallees } },
      ),
    ]);
    for (const row of rowsOf(callers.data, "caller lookup")) {
      relationships.push(relationship(row, "CALLS", "incoming", "symbol is called by this caller"));
    }
    for (const row of rowsOf(callees.data, "callee lookup")) {
      relationships.push(relationship(row, "CALLS", "outgoing", "symbol calls this callee"));
    }

    const relatedSymbolIds = [
      ...rowsOf(callers.data, "caller lookup").map((row) => requiredString(row, "fromId")),
      ...rowsOf(callees.data, "callee lookup").map((row) => requiredString(row, "toId")),
    ];
    if (relatedSymbolIds.length > 0) {
      const relatedSymbols = await graph.roQuery<QueryRow>(
        `
          MATCH (s:Symbol)
          WHERE s.id IN $symbolIds
          RETURN s.id AS id, s.name AS name, s.qualifiedName AS qualifiedName,
                 s.kind AS kind, s.filePath AS filePath, s.lineNumber AS lineNumber,
                 s.endLineNumber AS endLineNumber, s.language AS language
        `,
        { params: { symbolIds: relatedSymbolIds } },
      );
      for (const row of rowsOf(relatedSymbols.data, "related symbol lookup")) {
        items.push(itemForSymbol(row, "direct CALLS neighbor"));
      }
    }
  }

  const uniqueItems = deduplicateItems(items);
  const uniqueRelationships = deduplicateRelationships(relationships);
  return {
    diagnostic,
    items: uniqueItems,
    relationships: uniqueRelationships,
    metadata: {
      graphName,
      diagnosticId,
      counts: {
        items: uniqueItems.length,
        files: uniqueItems.filter((item) => item.kind === "file").length,
        symbols: uniqueItems.filter((item) => item.kind === "symbol").length,
        relationships: uniqueRelationships.length,
      },
      limits,
    },
  };
}

export async function retrieveDiagnosticContext(
  diagnosticId: string,
  requestedLimits: ContextRetrievalLimits = {},
): Promise<DiagnosticContext> {
  if (diagnosticId.trim().length === 0) {
    throw new Error("diagnosticId must not be empty");
  }
  const limits = limitsOf(requestedLimits);
  const db = await connectToGraph();
  try {
    return await retrieveOnGraph(db.selectGraph(graphName), diagnosticId, limits);
  } finally {
    await db.close();
  }
}

export async function retrieveLatestDiagnosticContexts(
  rootDir: string,
  requestedLimits: ContextRetrievalLimits = {},
): Promise<readonly DiagnosticContext[]> {
  const absoluteRoot = resolve(rootDir);
  const limits = limitsOf(requestedLimits);
  const db = await connectToGraph();
  try {
    const graph = db.selectGraph(graphName);
    const latest = await graph.roQuery<QueryRow>(
      `
        MATCH (session:Session)
        WHERE session.goal = 'compiler diagnostic scan'
          AND session.baselineRevision = $rootDir
        RETURN session.id AS sessionId
        ORDER BY session.startedAt DESC
        LIMIT 1
      `,
      { params: { rootDir: absoluteRoot } },
    );
    const sessionRows = rowsOf(latest.data, "latest diagnostic session lookup");
    if (sessionRows.length === 0) return [];
    const sessionId = requiredString(sessionRows[0], "sessionId");
    const diagnostics = await graph.roQuery<QueryRow>(
      `
        MATCH (session:Session {id: $sessionId})-[:TARGETS]->(d:Diagnostic)
        RETURN d.id AS diagnosticId
        ORDER BY d.filePath, d.lineNumber, d.columnNumber, d.id
        LIMIT $limit
      `,
      { params: { sessionId, limit: limits.maxDiagnostics } },
    );
    const diagnosticRows = rowsOf(diagnostics.data, "latest diagnostic lookup");
    const contexts: DiagnosticContext[] = [];
    for (const row of diagnosticRows) {
      contexts.push(await retrieveOnGraph(graph, requiredString(row, "diagnosticId"), limits));
    }
    return contexts;
  } finally {
    await db.close();
  }
}
