import { resolve } from "node:path";
import {
  ingestCompilerDiagnostics,
  listLatestCompilerDiagnostics,
} from "./diagnostics/diagnostic-ingest";

async function main(): Promise<void> {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const summary = await ingestCompilerDiagnostics(rootDir);
  console.log(
    `Recorded diagnostic scan ${summary.sessionId}: ` +
      `${summary.diagnosticCount} diagnostics ` +
      `(${summary.errorCount} errors, ${summary.warningCount} warnings).`,
  );

  const latest = await listLatestCompilerDiagnostics(rootDir);
  for (const row of latest) {
    console.log(JSON.stringify(row));
  }
}

main().catch((error: unknown) => {
  console.error(
    "Compiler diagnostic ingestion failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
