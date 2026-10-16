import { assembleDebugContext } from "./debugging/context-assembler";

async function main(): Promise<void> {
  const diagnosticId = process.argv[2]?.trim();
  if (diagnosticId === undefined || diagnosticId.length === 0) {
    throw new Error("Usage: investigate <diagnostic-id>");
  }
  console.log(JSON.stringify(await assembleDebugContext(diagnosticId), null, 2));
}

main().catch((error: unknown) => {
  console.error(
    "Debugging investigation failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
