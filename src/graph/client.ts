
import { FalkorDB } from "falkordb";

const host = process.env.FALKORDB_HOST ?? "127.0.0.1";
const port = Number(process.env.FALKORDB_PORT ?? 6379);

export const graphName = process.env.FALKORDB_GRAPH?.trim() || "DebugGraph";

export async function connectToGraph(): Promise<FalkorDB> {
  return FalkorDB.connect({ host, port });
}
