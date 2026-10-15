import {
  ConstraintType,
  EntityType,
  type Graph,
} from "falkordb";
import { connectToGraph, graphName } from "./client";

type SchemaDefinition = {
  readonly label: string;
  readonly indexes: readonly (readonly string[])[];
  readonly uniqueConstraints: readonly (readonly string[])[];
};

type MetadataRow = Readonly<Record<string, unknown>>;

export type SchemaValidationResult = {
  readonly valid: boolean;
  readonly missingIndexes: readonly string[];
  readonly missingUniqueConstraints: readonly string[];
  readonly nonOperationalUniqueConstraints: readonly string[];
};

const INDEX_POLL_INTERVAL_MS = 100;
const CONSTRAINT_TIMEOUT_MS = 10_000;

const schemaDefinitions: readonly SchemaDefinition[] = [
  {
    label: "Service",
    indexes: [["id"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "File",
    indexes: [["id"], ["filePath"]],
    uniqueConstraints: [["id"], ["filePath"]],
  },
  {
    label: "Symbol",
    indexes: [["id"], ["qualifiedName"], ["filePath"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "Type",
    indexes: [["id"], ["qualifiedName"], ["shapeHash"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "APIEndpoint",
    indexes: [["id"], ["method", "path"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "Diagnostic",
    indexes: [["id"], ["fingerprint"], ["observedAt"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "Session",
    indexes: [["id"], ["problemFingerprint"], ["startedAt"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "DebugAttempt",
    indexes: [["id"], ["attemptFingerprint"], ["sequenceNo"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "Hypothesis",
    indexes: [["id"], ["hypothesisFingerprint"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "Patch",
    indexes: [["id"], ["patchHash"]],
    uniqueConstraints: [["id"]],
  },
  {
    label: "Evidence",
    indexes: [["id"], ["observedAt"], ["kind"]],
    uniqueConstraints: [["id"]],
  },
];

function isMetadataRow(value: unknown): value is MetadataRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertiesOf(row: MetadataRow): readonly string[] | undefined {
  const properties = row.properties;
  if (!Array.isArray(properties) || !properties.every((value) => typeof value === "string")) {
    return undefined;
  }
  return properties;
}

function indexTypesOf(
  row: MetadataRow,
): Readonly<Record<string, readonly string[]>> | undefined {
  if (
    typeof row.types !== "object"
    || row.types === null
    || Array.isArray(row.types)
  ) {
    return undefined;
  }

  const types: Record<string, readonly string[]> = {};
  for (const [property, value] of Object.entries(row.types)) {
    if (
      !Array.isArray(value)
      || !value.every((type) => typeof type === "string")
    ) {
      return undefined;
    }
    types[property] = value;
  }
  return types;
}

function labelOf(row: MetadataRow): string | undefined {
  return typeof row.label === "string" ? row.label : undefined;
}

function statusOf(row: MetadataRow, query: string): string {
  if (typeof row.status !== "string") {
    throw new Error(
      `FalkorDB metadata row for ${query} has no string status`,
    );
  }
  return row.status.toUpperCase();
}

function isPendingStatus(status: string): boolean {
  return status === "PENDING" || status === "UNDER CONSTRUCTION";
}

function sameProperties(
  actual: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  return actual !== undefined
    && actual.length === expected.length
    && actual.every((property, index) => property === expected[index]);
}

function hasSchemaEntry(
  rows: readonly MetadataRow[],
  label: string,
  properties: readonly string[],
): boolean {
  return rows.some((row) =>
    indexMatches(row, label, properties, "OPERATIONAL"),
  );
}

function indexMatches(
  row: MetadataRow,
  label: string,
  properties: readonly string[],
  requiredStatus?: string,
): boolean {
  if (labelOf(row) !== label) {
    return false;
  }

  const status = statusOf(row, "CALL db.indexes()");
  if (requiredStatus !== undefined && status !== requiredStatus) {
    return false;
  }

  const indexTypes = indexTypesOf(row);
  return indexTypes !== undefined
    && properties.every((property) =>
      indexTypes[property]?.includes("RANGE") === true,
    );
}

function constraintStatus(
  rows: readonly MetadataRow[],
  label: string,
  properties: readonly string[],
): string | undefined {
  const row = rows.find((candidate) =>
    labelOf(candidate) === label
      && sameProperties(propertiesOf(candidate), properties),
  );
  return row === undefined
    ? undefined
    : statusOf(row, "CALL db.constraints()");
}

function indexStatus(
  rows: readonly MetadataRow[],
  label: string,
  properties: readonly string[],
): string | undefined {
  const row = rows.find((candidate) => indexMatches(candidate, label, properties));
  return row === undefined
    ? undefined
    : statusOf(row, "CALL db.indexes()");
}

async function metadataRows(
  graph: Graph,
  query: "CALL db.indexes()" | "CALL db.constraints()",
): Promise<readonly MetadataRow[]> {
  const result = await graph.roQuery<unknown>(query);
  if (result.data === undefined) {
    return [];
  }

  return result.data.map((value, index) => {
    if (!isMetadataRow(value)) {
      throw new Error(
        `Unexpected FalkorDB metadata row at index ${index} for ${query}: ` +
          "expected an object",
      );
    }

    if (labelOf(value) === undefined || propertiesOf(value) === undefined) {
      throw new Error(
        `Unexpected FalkorDB metadata row at index ${index} for ${query}: ` +
          "expected string label and ordered string properties",
      );
    }

    statusOf(value, query);
    if (query === "CALL db.indexes()" && indexTypesOf(value) === undefined) {
      throw new Error(
        `Unexpected FalkorDB metadata row at index ${index} for ${query}: ` +
          "expected a property-to-index-types map",
      );
    }

    return value;
  });
}

function itemName(
  kind: "index" | "unique constraint",
  label: string,
  properties: readonly string[],
): string {
  return `${kind} ${label}(${properties.join(", ")})`;
}

async function waitForOperationalIndex(
  graph: Graph,
  label: string,
  properties: readonly string[],
): Promise<void> {
  const deadline = Date.now() + CONSTRAINT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const indexes = await metadataRows(graph, "CALL db.indexes()");
    const status = indexStatus(indexes, label, properties);

    if (status === "OPERATIONAL") {
      return;
    }
    if (status === undefined || status.includes("UNDER CONSTRUCTION")) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, INDEX_POLL_INTERVAL_MS);
      });
      continue;
    }

    throw new Error(
      `Unexpected status "${status}" for ${itemName("index", label, properties)}`,
    );
  }

  throw new Error(
    `Timed out waiting for ${itemName("index", label, properties)} to become OPERATIONAL`,
  );
}

async function waitForOperationalConstraint(
  graph: Graph,
  label: string,
  properties: readonly string[],
): Promise<void> {
  const deadline = Date.now() + CONSTRAINT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const constraints = await metadataRows(graph, "CALL db.constraints()");
    const status = constraintStatus(constraints, label, properties);

    if (status === "OPERATIONAL") {
      return;
    }
    if (status === "FAILED") {
      throw new Error(
        `Unique constraint ${itemName("unique constraint", label, properties)} failed`,
      );
    }
    if (status !== undefined && !isPendingStatus(status)) {
      throw new Error(
        `Unexpected status "${status}" for ${itemName(
          "unique constraint",
          label,
          properties,
        )}`,
      );
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, INDEX_POLL_INTERVAL_MS);
    });
  }

  throw new Error(
    `Timed out waiting for ${itemName("unique constraint", label, properties)} to become OPERATIONAL`,
  );
}

async function schemaState(graph: Graph): Promise<{
  readonly indexes: readonly MetadataRow[];
  readonly constraints: readonly MetadataRow[];
}> {
  const [indexes, constraints] = await Promise.all([
    metadataRows(graph, "CALL db.indexes()"),
    metadataRows(graph, "CALL db.constraints()"),
  ]);
  return { indexes, constraints };
}

export async function initializeSchema(): Promise<void> {
  const db = await connectToGraph();

  try {
    const graph = db.selectGraph(graphName);
    let { indexes } = await schemaState(graph);

    for (const definition of schemaDefinitions) {
      for (const properties of definition.indexes) {
        if (!hasSchemaEntry(indexes, definition.label, properties)) {
          await graph.createNodeRangeIndex(definition.label, ...properties);
        }
        await waitForOperationalIndex(graph, definition.label, properties);
        indexes = await metadataRows(graph, "CALL db.indexes()");
      }
    }

    // Index creation changes metadata asynchronously; do not use the initial snapshot.
    ({ indexes } = await schemaState(graph));

    for (const definition of schemaDefinitions) {
      for (const properties of definition.uniqueConstraints) {
        if (!hasSchemaEntry(indexes, definition.label, properties)) {
          throw new Error(
            `Cannot create ${itemName("unique constraint", definition.label, properties)}: ` +
              "the supporting exact-match index is missing",
          );
        }

        let constraints = await metadataRows(graph, "CALL db.constraints()");
        const status = constraintStatus(constraints, definition.label, properties);

        if (status === undefined) {
          await graph.constraintCreate(
            ConstraintType.UNIQUE,
            EntityType.NODE,
            definition.label,
            ...properties,
          );
        } else if (status === "FAILED") {
          throw new Error(
            `Existing ${itemName("unique constraint", definition.label, properties)} is FAILED`,
          );
        } else if (!isPendingStatus(status) && status !== "OPERATIONAL") {
          throw new Error(
            `Unexpected status "${status}" for ${itemName(
              "unique constraint",
              definition.label,
              properties,
            )}`,
          );
        }

        await waitForOperationalConstraint(
          graph,
          definition.label,
          properties,
        );
      }
    }
  } finally {
    await db.close();
  }
}

export async function validateSchema(): Promise<SchemaValidationResult> {
  const db = await connectToGraph();

  try {
    const graph = db.selectGraph(graphName);
    const { indexes, constraints } = await schemaState(graph);
    const missingIndexes: string[] = [];
    const missingUniqueConstraints: string[] = [];
    const nonOperationalUniqueConstraints: string[] = [];

    for (const definition of schemaDefinitions) {
      for (const properties of definition.indexes) {
        if (!hasSchemaEntry(indexes, definition.label, properties)) {
          missingIndexes.push(itemName("index", definition.label, properties));
        }
      }

      for (const properties of definition.uniqueConstraints) {
        const name = itemName("unique constraint", definition.label, properties);
        const status = constraintStatus(constraints, definition.label, properties);

        if (status === undefined) {
          missingUniqueConstraints.push(name);
        } else if (status !== "OPERATIONAL") {
          nonOperationalUniqueConstraints.push(`${name} (${status})`);
        }
      }
    }

    return {
      valid:
        missingIndexes.length === 0
        && missingUniqueConstraints.length === 0
        && nonOperationalUniqueConstraints.length === 0,
      missingIndexes,
      missingUniqueConstraints,
      nonOperationalUniqueConstraints,
    };
  } finally {
    await db.close();
  }
}
