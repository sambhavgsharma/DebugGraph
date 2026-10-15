import { posix } from "node:path";
import { connectToGraph, graphName } from "./client";

export type ServiceInput = {
  readonly id: string;
  readonly name: string;
  readonly runtime: "nextjs" | "nodejs" | "python" | "other";
  readonly role: "frontend" | "backend" | "worker" | "test" | "other";
  readonly rootPath: string;
};

export type FileInput = {
  readonly id: string;
  readonly filePath: string;
  readonly language: string;
  readonly contentHash?: string;
};

export type UpsertServiceFileInput = {
  readonly service: ServiceInput;
  readonly file: FileInput;
  readonly sourceKind?:
    | "static_analysis"
    | "runtime_trace"
    | "test_run"
    | "compiler"
    | "llm_inference"
    | "rule_based"
    | "manual";
};

export type UpsertServiceFileResult = {
  readonly serviceId: string;
  readonly fileId: string;
  readonly filePath: string;
  readonly relationshipType: "CONTAINS_FILE";
};

type PersistedRow = Readonly<Record<string, unknown>>;

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function validateService(service: ServiceInput): void {
  requireNonEmpty(service.id, "service.id");
  requireNonEmpty(service.name, "service.name");
  requireNonEmpty(service.rootPath, "service.rootPath");
}

function validateFile(file: FileInput): void {
  requireNonEmpty(file.id, "file.id");
  requireNonEmpty(file.filePath, "file.filePath");
  requireNonEmpty(file.language, "file.language");

  if (
    file.filePath.includes("\\")
    || file.filePath.startsWith("/")
    || /^[A-Za-z]:\//.test(file.filePath)
    || file.filePath === "."
    || file.filePath === ".."
    || file.filePath.startsWith("../")
    || file.filePath.includes("\0")
    || posix.normalize(file.filePath) !== file.filePath
  ) {
    throw new Error(
      "file.filePath must be a normalized repository-relative path using '/' separators",
    );
  }

  if (file.contentHash !== undefined) {
    requireNonEmpty(file.contentHash, "file.contentHash");
  }
}

function validateInput(input: UpsertServiceFileInput): void {
  validateService(input.service);
  validateFile(input.file);
}

function isPersistedRow(value: unknown): value is PersistedRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: PersistedRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`FalkorDB upsert result did not contain string field "${field}"`);
  }
  return value;
}

export async function upsertServiceAndFile(
  input: UpsertServiceFileInput,
): Promise<UpsertServiceFileResult> {
  validateInput(input);

  const db = await connectToGraph();

  try {
    const graph = db.selectGraph(graphName);
    const indexedAt = new Date().toISOString();
    const sourceKind = input.sourceKind ?? "static_analysis";
    const contentHashAssignment = input.file.contentHash === undefined
      ? ""
      : ", f.contentHash = $contentHash";

    const result = await graph.query<PersistedRow>(
      `
        MERGE (s:Service {id: $serviceId})
        ON CREATE SET s.createdAt = $createdAt
        SET s.name = $serviceName,
            s.runtime = $runtime,
            s.role = $role,
            s.rootPath = $rootPath
        MERGE (f:File {id: $fileId})
        SET f.filePath = $filePath,
            f.language = $language,
            f.lastIndexedAt = $indexedAt${contentHashAssignment}
        MERGE (s)-[r:CONTAINS_FILE]->(f)
        ON CREATE SET r.createdAt = $createdAt, r.sourceKind = $sourceKind
        RETURN s.id AS serviceId,
               f.id AS fileId,
               f.filePath AS filePath,
               type(r) AS relationshipType
      `,
      {
        params: {
          serviceId: input.service.id,
          createdAt: indexedAt,
          serviceName: input.service.name,
          runtime: input.service.runtime,
          role: input.service.role,
          rootPath: input.service.rootPath,
          fileId: input.file.id,
          filePath: input.file.filePath,
          language: input.file.language,
          indexedAt,
          ...(input.file.contentHash === undefined
            ? {}
            : { contentHash: input.file.contentHash }),
          sourceKind,
        },
      },
    );

    const rows = result.data ?? [];
    if (rows.length !== 1 || !isPersistedRow(rows[0])) {
      throw new Error("FalkorDB upsert did not return exactly one result row");
    }

    const relationshipType = stringField(rows[0], "relationshipType");
    if (relationshipType !== "CONTAINS_FILE") {
      throw new Error(
        `FalkorDB upsert returned unexpected relationship type "${relationshipType}"`,
      );
    }

    return {
      serviceId: stringField(rows[0], "serviceId"),
      fileId: stringField(rows[0], "fileId"),
      filePath: stringField(rows[0], "filePath"),
      relationshipType,
    };
  } finally {
    await db.close();
  }
}
