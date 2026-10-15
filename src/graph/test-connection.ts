
import { FalkorDB } from "falkordb";

async function main(): Promise<void> {
  const db = await FalkorDB.connect({
    host: process.env.FALKORDB_HOST ?? "127.0.0.1",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
  });

  try {
    const graph = db.selectGraph("DebugGraph");

    const result = await graph.query(`
      CREATE (:ConnectionTest {message: 'Hello from TypeScript'})
      RETURN 'Connected successfully' AS status
    `);

    console.log("FalkorDB connection successful!");
    console.log("Query result:", result.data);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error("FalkorDB connection test failed:", error);
  process.exitCode = 1;
});
