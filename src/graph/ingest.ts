import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { graphName, connectToGraph } from "./client";
import {
  parseProject,
  type ParsedCall,
  type ParsedImport,
  type ParsedProject,
} from "../parser/project-parser";

export type IngestionSummary = {
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly importCount: number;
  readonly callCount: number;
};

type QueryRow = Readonly<Record<string, unknown>>;

const WRITE_BATCH_SIZE = 250;

function stableServiceId(rootDir: string): string {
  return createHash("sha256")
    .update(`service:${rootDir}`)
    .digest("hex");
}

function queryRows(project: ParsedProject): {
  readonly files: readonly Record<string, string>[];
  readonly symbols: readonly Record<string, string | number>[];
} {
  return {
    files: project.files.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      language: file.language,
      contentHash: file.contentHash,
      lastIndexedAt: new Date().toISOString(),
    })),
    symbols: project.symbols.map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      filePath: symbol.filePath,
      lineNumber: symbol.lineNumber,
      endLineNumber: symbol.endLineNumber,
      language: symbol.language,
      signature: symbol.signature,
      contentHash: symbol.contentHash,
    })),
  };
}

async function writeFiles(
  graph: import("falkordb").Graph,
  files: readonly Record<string, string>[],
): Promise<void> {
  for (let offset = 0; offset < files.length; offset += WRITE_BATCH_SIZE) {
    await graph.query(
      `
        UNWIND $files AS item
        MERGE (f:File {id: item.id})
        SET f.filePath = item.filePath,
            f.language = item.language,
            f.contentHash = item.contentHash,
            f.lastIndexedAt = item.lastIndexedAt
      `,
      { params: { files: files.slice(offset, offset + WRITE_BATCH_SIZE) } },
    );
  }
}

async function writeSymbols(
  graph: import("falkordb").Graph,
  symbols: readonly Record<string, string | number>[],
): Promise<void> {
  for (let offset = 0; offset < symbols.length; offset += WRITE_BATCH_SIZE) {
    await graph.query(
      `
        UNWIND $symbols AS item
        MERGE (s:Symbol {id: item.id})
        SET s.name = item.name,
            s.qualifiedName = item.qualifiedName,
            s.kind = item.kind,
            s.filePath = item.filePath,
            s.lineNumber = item.lineNumber,
            s.endLineNumber = item.endLineNumber,
            s.language = item.language,
            s.signature = item.signature,
            s.contentHash = item.contentHash
      `,
      { params: { symbols: symbols.slice(offset, offset + WRITE_BATCH_SIZE) } },
    );
  }
}

async function writeContainsSymbolEdges(
  graph: import("falkordb").Graph,
  symbols: readonly ParsedProject["symbols"][number][],
  createdAt: string,
): Promise<void> {
  const edges = symbols.map((symbol) => ({
    fileId: stableFileId(symbol.filePath),
    symbolId: symbol.id,
  }));

  for (let offset = 0; offset < edges.length; offset += WRITE_BATCH_SIZE) {
    await graph.query(
      `
        UNWIND $edges AS edge
        MATCH (f:File {id: edge.fileId}), (s:Symbol {id: edge.symbolId})
        MERGE (f)-[r:CONTAINS]->(s)
        ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'static_analysis'
      `,
      {
        params: {
          edges: edges.slice(offset, offset + WRITE_BATCH_SIZE),
          createdAt,
        },
      },
    );
  }
}

function stableFileId(filePath: string): string {
  return createHash("sha256").update(`file:${filePath}`).digest("hex");
}

async function writeContainsFileEdges(
  graph: import("falkordb").Graph,
  serviceId: string,
  fileIds: readonly string[],
  createdAt: string,
): Promise<void> {
  for (let offset = 0; offset < fileIds.length; offset += WRITE_BATCH_SIZE) {
    await graph.query(
      `
        UNWIND $fileIds AS fileId
        MATCH (s:Service {id: $serviceId}), (f:File {id: fileId})
        MERGE (s)-[r:CONTAINS_FILE]->(f)
        ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'static_analysis'
      `,
      {
        params: {
          serviceId,
          fileIds: fileIds.slice(offset, offset + WRITE_BATCH_SIZE),
          createdAt,
        },
      },
    );
  }
}

async function writeImportEdges(
  graph: import("falkordb").Graph,
  imports: readonly ParsedImport[],
  fileIds: ReadonlyMap<string, string>,
  createdAt: string,
): Promise<void> {
  const edges = imports.flatMap((item) => {
    const sourceId = fileIds.get(item.sourceFilePath);
    const targetId = fileIds.get(item.targetFilePath);
    return sourceId && targetId ? [{ sourceId, targetId }] : [];
  });

  for (let offset = 0; offset < edges.length; offset += WRITE_BATCH_SIZE) {
    await graph.query(
      `
        UNWIND $edges AS edge
        MATCH (source:File {id: edge.sourceId}),
              (target:File {id: edge.targetId})
        MERGE (source)-[r:IMPORTS]->(target)
        ON CREATE SET r.createdAt = $createdAt, r.sourceKind = 'static_analysis'
      `,
      {
        params: {
          edges: edges.slice(offset, offset + WRITE_BATCH_SIZE),
          createdAt,
        },
      },
    );
  }
}

async function writeCallEdges(
  graph: import("falkordb").Graph,
  calls: readonly ParsedCall[],
  createdAt: string,
): Promise<void> {
  for (let offset = 0; offset < calls.length; offset += WRITE_BATCH_SIZE) {
    await graph.query(
      `
        UNWIND $edges AS edge
        MATCH (source:Symbol {id: edge.sourceSymbolId}),
              (target:Symbol {id: edge.targetSymbolId})
        MERGE (source)-[r:CALLS]->(target)
        ON CREATE SET r.createdAt = $createdAt,
                      r.sourceKind = 'static_analysis',
                      r.callSiteLine = edge.callSiteLine
        ON MATCH SET r.callSiteLine = edge.callSiteLine
      `,
      {
        params: {
          edges: calls.slice(offset, offset + WRITE_BATCH_SIZE),
          createdAt,
        },
      },
    );
  }
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function ingestProject(rootDir: string): Promise<IngestionSummary> {
  const absoluteRoot = resolve(rootDir);
  const project = parseProject(absoluteRoot);
  const db = await connectToGraph();

  try {
    const graph = db.selectGraph(graphName);
    const createdAt = new Date().toISOString();
    const serviceId = stableServiceId(absoluteRoot);
    const rows = queryRows(project);

    await graph.query(
      `
        MERGE (s:Service {id: $serviceId})
        ON CREATE SET s.createdAt = $createdAt
        SET s.name = $serviceName,
            s.runtime = 'other',
            s.role = 'other',
            s.rootPath = $rootPath
      `,
      {
        params: {
          serviceId,
          createdAt,
          serviceName: basename(absoluteRoot),
          rootPath: absoluteRoot,
        },
      },
    );

    await writeFiles(graph, rows.files);
    await writeSymbols(graph, rows.symbols);
    await writeContainsSymbolEdges(graph, project.symbols, createdAt);

    const fileIds = new Map(
      project.files.map((file) => [file.filePath, file.id]),
    );
    await writeContainsFileEdges(
      graph,
      serviceId,
      project.files.map((file) => file.id),
      createdAt,
    );
    await writeImportEdges(graph, project.imports, fileIds, createdAt);
    await writeCallEdges(graph, project.calls, createdAt);

    const result = await graph.query<QueryRow>(
      `
        MATCH (s:Service {id: $serviceId})
        RETURN s.id AS serviceId
      `,
      { params: { serviceId } },
    );
    if (result.data?.length !== 1 || !isQueryRow(result.data[0])) {
      throw new Error("Ingestion did not return the persisted service");
    }

    return {
      fileCount: project.files.length,
      symbolCount: project.symbols.length,
      importCount: project.imports.length,
      callCount: project.calls.length,
    };
  } finally {
    await db.close();
  }
}
