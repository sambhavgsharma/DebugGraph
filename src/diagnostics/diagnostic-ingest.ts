import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { connectToGraph, graphName } from "../graph/client";
import type { FalkorDB } from "falkordb";
import { parseProject, type ParsedSymbol } from "../parser/project-parser";

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out",
  "coverage", ".turbo", ".vercel",
]);

export type CompilerDiagnostic = {
  readonly id: string;
  readonly fingerprint: string;
  readonly category: "error" | "warning" | "suggestion" | "message";
  readonly severity: "error" | "warning" | "suggestion" | "message";
  readonly message: string;
  readonly code: number;
  readonly sourceKind: "compiler";
  readonly observedAt: string;
  readonly filePath?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly symbolId?: string;
};

export type DiagnosticScanSummary = {
  readonly sessionId: string;
  readonly diagnosticCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly startedAt: string;
  readonly endedAt: string;
};

type DiagnosticRow = Readonly<Record<string, string | number | null>>;
type QueryRow = Readonly<Record<string, unknown>>;
export type DiagnosticGraphConnectionFactory = () => Promise<FalkorDB>;

function stableId(kind: string, identity: string): string {
  return createHash("sha256").update(`${kind}:${identity}`).digest("hex");
}

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function scanSourceFiles(rootDir: string): readonly string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(resolve(entryPath));
      }
    }
  }
  visit(rootDir);
  return files.sort();
}

function compilerConfiguration(rootDir: string): {
  readonly options: ts.CompilerOptions;
  readonly fileNames: readonly string[];
  readonly errors: readonly ts.Diagnostic[];
} {
  const configPath = join(rootDir, "tsconfig.json");
  if (!statSync(configPath, { throwIfNoEntry: false })) {
    return {
      options: {
        allowJs: true,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.Latest,
      },
      fileNames: scanSourceFiles(rootDir),
      errors: [],
    };
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    return {
      options: { allowJs: true },
      fileNames: scanSourceFiles(rootDir),
      errors: [config.error],
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    rootDir,
    { allowJs: true },
    configPath,
  );
  return {
    options: { ...parsed.options, allowJs: true },
    fileNames: parsed.fileNames.length > 0 ? parsed.fileNames : scanSourceFiles(rootDir),
    errors: parsed.errors,
  };
}

function categoryOf(category: ts.DiagnosticCategory): CompilerDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error: return "error";
    case ts.DiagnosticCategory.Warning: return "warning";
    case ts.DiagnosticCategory.Suggestion: return "suggestion";
    default: return "message";
  }
}

function messageOf(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function symbolForDiagnostic(
  symbols: readonly ParsedSymbol[],
  filePath: string | undefined,
  lineNumber: number | undefined,
): ParsedSymbol | undefined {
  if (filePath === undefined || lineNumber === undefined) return undefined;
  return symbols
    .filter((symbol) =>
      symbol.filePath === filePath
      && symbol.lineNumber <= lineNumber
      && symbol.endLineNumber >= lineNumber,
    )
    .sort((left, right) =>
      (right.lineNumber - left.lineNumber)
      || (left.endLineNumber - right.endLineNumber),
    )[0];
}

function toCompilerDiagnostic(
  diagnostic: ts.Diagnostic,
  rootDir: string,
  symbols: readonly ParsedSymbol[],
  observedAt: string,
): CompilerDiagnostic {
  const filePath = diagnostic.file
    ? normalizePath(relative(rootDir, resolve(diagnostic.file.fileName)))
    : undefined;
  const start = diagnostic.start;
  const position = diagnostic.file && start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(start)
    : undefined;
  const lineNumber = position ? position.line + 1 : undefined;
  const columnNumber = position ? position.character + 1 : undefined;
  const category = categoryOf(diagnostic.category);
  const message = messageOf(diagnostic);
  const identity = [
    filePath ?? "<project>",
    lineNumber ?? 0,
    columnNumber ?? 0,
    diagnostic.code,
    category,
    message,
  ].join("|");
  const fingerprint = stableId("diagnostic", identity);
  const symbol = symbolForDiagnostic(symbols, filePath, lineNumber);

  return {
    id: fingerprint,
    fingerprint,
    category,
    severity: category,
    message,
    code: diagnostic.code,
    sourceKind: "compiler",
    observedAt,
    ...(filePath === undefined ? {} : { filePath }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(columnNumber === undefined ? {} : { columnNumber }),
    ...(symbol === undefined ? {} : { symbolId: symbol.id }),
  };
}

function rowsForDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): DiagnosticRow[] {
  return diagnostics.map((diagnostic) => ({
    id: diagnostic.id,
    fingerprint: diagnostic.fingerprint,
    category: diagnostic.category,
    severity: diagnostic.severity,
    message: diagnostic.message,
    code: diagnostic.code,
    sourceKind: diagnostic.sourceKind,
    observedAt: diagnostic.observedAt,
    filePath: diagnostic.filePath ?? null,
    lineNumber: diagnostic.lineNumber ?? null,
    columnNumber: diagnostic.columnNumber ?? null,
    symbolId: diagnostic.symbolId ?? null,
  }));
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeDiagnostics(
  graph: import("falkordb").Graph,
  sessionId: string,
  diagnostics: readonly CompilerDiagnostic[],
): Promise<void> {
  const rows = rowsForDiagnostics(diagnostics);
  await graph.query(
    `
      UNWIND $diagnostics AS item
      MERGE (d:Diagnostic {id: item.id})
      SET d.fingerprint = item.fingerprint,
          d.category = item.category,
          d.severity = item.severity,
          d.message = item.message,
          d.code = item.code,
          d.sourceKind = item.sourceKind,
          d.observedAt = item.observedAt,
          d.filePath = item.filePath,
          d.lineNumber = item.lineNumber,
          d.columnNumber = item.columnNumber
      WITH d, item
      MATCH (s:Session {id: $sessionId})
      MERGE (s)-[target:TARGETS]->(d)
      ON CREATE SET target.createdAt = $observedAt, target.sourceKind = 'compiler'
    `,
    { params: { diagnostics: rows, sessionId, observedAt: diagnostics[0]?.observedAt ?? new Date().toISOString() } },
  );

  const located = rows.filter((row) => row.filePath !== null);
  if (located.length > 0) {
    await graph.query(
      `
        UNWIND $diagnostics AS item
        MATCH (d:Diagnostic {id: item.id}), (f:File {filePath: item.filePath})
        MERGE (d)-[r:LOCATED_IN]->(f)
        ON CREATE SET r.createdAt = item.observedAt, r.sourceKind = 'compiler'
      `,
      { params: { diagnostics: located } },
    );
  }

  const symbolLocated = rows.filter((row) => row.symbolId !== null);
  if (symbolLocated.length > 0) {
    await graph.query(
      `
        UNWIND $diagnostics AS item
        MATCH (d:Diagnostic {id: item.id}), (s:Symbol {id: item.symbolId})
        MERGE (d)-[r:LOCATED_IN]->(s)
        ON CREATE SET r.createdAt = item.observedAt, r.sourceKind = 'inferred'
      `,
      { params: { diagnostics: symbolLocated } },
    );
  }
}

export async function ingestCompilerDiagnostics(
  rootDir: string,
): Promise<DiagnosticScanSummary> {
  const absoluteRoot = resolve(rootDir);
  const startedAt = new Date().toISOString();
  const configuration = compilerConfiguration(absoluteRoot);
  const program = ts.createProgram(configuration.fileNames, configuration.options);
  const symbols: readonly ParsedSymbol[] = configuration.errors.length === 0
    ? parseProject(absoluteRoot).symbols
    : [];
  const diagnostics = [
    ...configuration.errors,
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((diagnostic) =>
    diagnostic.file === undefined
    || resolve(diagnostic.file.fileName).startsWith(`${absoluteRoot}${sep}`),
  ).map((diagnostic) =>
    toCompilerDiagnostic(diagnostic, absoluteRoot, symbols, startedAt),
  );
  const endedAt = new Date().toISOString();
  const sessionId = stableId("diagnostic-session", `${absoluteRoot}:${startedAt}`);
  const db = await connectToGraph();

  try {
    const graph = db.selectGraph(graphName);
    await graph.query(
      `
        MERGE (s:Session {id: $sessionId})
        SET s.goal = 'compiler diagnostic scan',
            s.status = 'completed',
            s.problemFingerprint = $problemFingerprint,
            s.startedAt = $startedAt,
            s.endedAt = $endedAt,
            s.baselineRevision = $rootDir
      `,
      {
        params: {
          sessionId,
          problemFingerprint: stableId("diagnostic-scan", absoluteRoot),
          startedAt,
          endedAt,
          rootDir: absoluteRoot,
        },
      },
    );
    await writeDiagnostics(graph, sessionId, diagnostics);
  } finally {
    await db.close();
  }

  return {
    sessionId,
    diagnosticCount: diagnostics.length,
    errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    startedAt,
    endedAt,
  };
}

export async function listLatestCompilerDiagnostics(
  rootDir: string,
  connect: DiagnosticGraphConnectionFactory = connectToGraph,
): Promise<readonly QueryRow[]> {
  const absoluteRoot = resolve(rootDir);
  const db = await connect();
  try {
    const graph = db.selectGraph(graphName);
    const latestSession = await graph.roQuery<QueryRow>(
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
    const sessionRow = latestSession.data?.[0];
    if (sessionRow === undefined) {
      return [];
    }
    if (!isQueryRow(sessionRow) || typeof sessionRow.sessionId !== "string") {
      throw new Error("Latest compiler diagnostic session result was malformed");
    }

    const result = await graph.roQuery<QueryRow>(
      `
        MATCH (session:Session {id: $sessionId})-[:TARGETS]->(diagnostic:Diagnostic)
        RETURN session.id AS sessionId,
               diagnostic.severity AS severity,
               diagnostic.code AS code,
               diagnostic.message AS message,
               diagnostic.filePath AS filePath,
               diagnostic.lineNumber AS lineNumber,
               diagnostic.columnNumber AS columnNumber
        ORDER BY diagnostic.filePath, diagnostic.lineNumber, diagnostic.columnNumber
      `,
      { params: { sessionId: sessionRow.sessionId } },
    );
    return (result.data ?? []).filter(isQueryRow);
  } finally {
    await db.close();
  }
}
