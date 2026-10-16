import { resolve } from "node:path";
import {
  retrieveDiagnosticContext,
  retrieveLatestDiagnosticContexts,
} from "./debugging/context-retrieval";

async function main(): Promise<void> {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const diagnosticId = process.argv[3]?.trim();
  const contexts = diagnosticId
    ? [await retrieveDiagnosticContext(diagnosticId)]
    : await retrieveLatestDiagnosticContexts(rootDir);
  console.log(JSON.stringify({ rootDir, contexts }, null, 2));
}

main().catch((error: unknown) => {
  console.error(
    "Debugging context retrieval failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
