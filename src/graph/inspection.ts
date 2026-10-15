import { connectToGraph, graphName } from "./client";

type QueryRow = Readonly<Record<string, unknown>>;

export type ServiceFile = {
  readonly serviceId: string;
  readonly fileId: string;
  readonly filePath: string;
  readonly language: string;
};

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function isQueryRow(value: unknown): value is QueryRow {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stringField(row: QueryRow, field: string): string {
  const value = row[field];

  if (typeof value !== "string") {
    throw new Error(
      `FalkorDB query result did not contain string field "${field}"`,
    );
  }

  return value;
}

export async function listFilesForService(
  serviceId: string,
): Promise<readonly ServiceFile[]> {
  requireNonEmpty(serviceId, "serviceId");

  const db = await connectToGraph();

  try {
    const graph = db.selectGraph(graphName);

    const result = await graph.query<QueryRow>(
      `
        MATCH (s:Service {id: $serviceId})-[:CONTAINS_FILE]->(f:File)
        RETURN s.id AS serviceId,
               f.id AS fileId,
               f.filePath AS filePath,
               f.language AS language
        ORDER BY f.filePath
      `,
      {
        params: { serviceId },
      },
    );

    const rows = result.data ?? [];

    return rows.map((value, index) => {
      if (!isQueryRow(value)) {
        throw new Error(
          `Unexpected FalkorDB result at row ${index}: expected an object`,
        );
      }

      return {
        serviceId: stringField(value, "serviceId"),
        fileId: stringField(value, "fileId"),
        filePath: stringField(value, "filePath"),
        language: stringField(value, "language"),
      };
    });
  } finally {
    await db.close();
  }
}