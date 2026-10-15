import { resolve } from "node:path";
import { ingestProject } from "./graph/ingest";

async function main(): Promise<void> {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const summary = await ingestProject(rootDir);

  console.log(
    `Ingested ${summary.fileCount} files, ${summary.symbolCount} symbols, ` +
      `${summary.importCount} local import records, and ` +
      `${summary.callCount} calls.`,
  );
}

main().catch((error: unknown) => {
  console.error(
    "Project ingestion failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
