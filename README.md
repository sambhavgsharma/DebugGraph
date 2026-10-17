# DebugGraph

DebugGraph is a graph-powered debugging foundation for AI coding agents. It
connects code structure, diagnostics, bounded code context, debugging
hypotheses, patches, attempts, test results, and evidence so an agent can
investigate possible causes and avoid repeating unsuccessful experiments
without new evidence.

The current repository implements TypeScript/JavaScript code ingestion,
compiler-diagnostic scanning, debugging-history recording, bounded
graph-backed context retrieval, evidence-based investigation, conservative
evidence reconciliation, and a read-only MCP tool. It persists these records
in FalkorDB and exposes them through CLI commands and the MCP server.
Autonomous code repair, including selecting and applying fixes, remains
unimplemented.

## Table of contents

- [Current status](#current-status)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Local setup on Windows](#local-setup-on-windows)
- [Daily development workflow](#daily-development-workflow)
- [Graph schema](#graph-schema)
- [Repository structure](#repository-structure)
- [Continuing development](#continuing-development)
- [Troubleshooting](#troubleshooting)

## Current status

### Implemented

- FalkorDB connection using `FALKORDB_HOST` and `FALKORDB_PORT`, defaulting to
  `127.0.0.1:6379`.
- Selection of the graph named by `FALKORDB_GRAPH` (the demo default is
  `DebugGraphDev`).
- Schema initialization and validation in
  [`src/graph/schema.ts`](./src/graph/schema.ts). Initialization creates the
  approved range indexes and unique constraints, waits for asynchronous
  metadata to become operational, and does not run automatically.
- Recursive parsing of `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`,
  and `.cjs` files using the TypeScript compiler API.
- Exclusion of dependency and build directories such as `node_modules`,
  `.git`, `.next`, `dist`, `build`, `out`, `coverage`, `.turbo`, and
  `.vercel`.
- File content SHA-256 hashes and deterministic file and symbol IDs.
- Extraction of functions, methods, classes, variables, local imports, and
  calls whose declarations resolve inside the scanned repository.
- One-based `CALLS.callSiteLine` source-line metadata.
- Idempotent ingestion with parameterized Cypher, `UNWIND` batches, and
  `MERGE`.
- Graph inspection through
  [`listFilesForService`](./src/graph/inspection.ts).
- A reusable service/file upsert in
  [`src/graph/operations.ts`](./src/graph/operations.ts).
- A CLI that reports parsed file, symbol, local-import, and call counts.
- Compiler diagnostic ingestion with timestamped scan sessions, stable
  diagnostic identities, source file locations, and nearest-symbol
  associations when the source position supports them.
- Latest-scan diagnostic output through the `diagnostics` CLI command.
- Bounded graph-backed diagnostic context retrieval through the `context` CLI
  command.
- Debugging sessions, hypotheses, attempts, patches, outcomes, and evidence
  with repeatable, write-once, and provenance-aware history operations.
- Read-only evidence-based investigation with bounded history retrieval,
  conservative reconciliation of diagnostic-associated versus project-level
  evidence, and recommendations that retain uncertainty.
- A read-only stdio MCP server exposing the same investigation assembler
  through the `debuggraph_investigate` tool.

### Not implemented yet

- A browser UI or HTTP application server.
- API endpoint tracing or cross-service type-contract tracing.
- Automatic selection or application of code repairs, including an autonomous
  coding-agent workflow.
- A VS Code debugging interface.
- Automatic schema initialization from an npm script.
- Broader repeated-failure detection beyond the current evidence-based
  recommendations.

The graph may contain older development or smoke-test records. Counts from a
particular local database are snapshots, not project guarantees.

## Architecture

DebugGraph is intended to maintain two related graph views:

1. **Code structure** — services, files, symbols, imports, calls, and
   eventually API and type relationships.
2. **Debugging history** — diagnostic observations, sessions, hypotheses,
   patches, attempts, tests, and evidence.

The code graph, compiler-diagnostic scans, bounded context traversal, and
debugging-history and investigation layers are implemented. Context retrieval
traverses nearby files, symbols, imports, calls, and diagnostic associations
within explicit limits. Investigation combines that context with bounded
diagnostic-targeted history and reconciles evidence conservatively. Autonomous
repair, browser/API surfaces, endpoint tracing, and broader retry-prevention
logic remain planned.

The ingestion flow is:

```text
repository root
    -> TypeScript compiler program and type checker
    -> ParsedProject
    -> parameterized FalkorDB MERGE/UNWIND writes
    -> DebugGraph
```

The diagnostic flow runs the configured TypeScript compiler program, records
syntactic, semantic, and configuration diagnostics, and creates a new
`Session` for every scan. A diagnostic remains in history after it is fixed,
but it is returned by the latest-scan query only when the newest scan reports
it.

## Prerequisites

The versions currently pinned or verified in the repository are:

- Git
- Node.js 24.x recommended for the current development environment
- npm
- Docker Desktop on Windows 10/11 for a local FalkorDB server
- A running FalkorDB instance reachable on Redis port `6379`
- VS Code recommended for editing and running the project
- TypeScript `5.9.3`
- `tsx` `^4.23.15`
- `falkordb` `^6.8.0`

The parser uses the legacy TypeScript compiler API. Do not replace the
project's TypeScript 5.9.3 dependency with TypeScript 7 without first
porting the parser to TypeScript 7's different API surface.

## Local setup on Windows

Run these commands from PowerShell.

### 1. Clone and enter the repository

The repository remote currently points to:

```powershell
git clone https://github.com/sambhavgsharma/DebugGraph.git
Set-Location .\DebugGraph
```

### 2. Install dependencies

```powershell
npm install
```

`package-lock.json` is committed, so `npm ci` is also suitable for a clean,
lockfile-only install:

```powershell
npm ci
```

Use one of these install commands, not both in the same setup.

### 3. Create local configuration

The repository provides [`.env.example`](./.env.example), but the current
Node code reads `process.env` directly and does not load `.env` files by
itself. In PowerShell, create the file without overwriting an existing local
file:

```powershell
if (-not (Test-Path .\.env)) {
  Copy-Item .\.env.example .\.env
}
```

The variables are:

| Variable | Default | Use |
| --- | --- | --- |
| `FALKORDB_HOST` | `127.0.0.1` | Host passed to `FalkorDB.connect`. |
| `FALKORDB_PORT` | `6379` | Port passed to `FalkorDB.connect`. |
| `FALKORDB_GRAPH` | `DebugGraphDev` in `.env.example`, otherwise `DebugGraph` | Graph selected by all graph operations. |
| `FALKORDB_VOLUME` | Compose configuration | External Docker volume mounted at `/var/lib/falkordb/data` by Compose. |

The current `.env` file is not loaded automatically by the application. Docker
Compose does use `.env` for Compose-variable interpolation, including the
volume name and port mapping. If the Node process needs values from the same
settings, load them explicitly or set the environment variables in the
PowerShell session, for example:

```powershell
$env:FALKORDB_HOST = "127.0.0.1"
$env:FALKORDB_PORT = "6379"
$env:FALKORDB_GRAPH = "DebugGraphDev"
```

Never commit `.env`. The repository's `.gitignore` excludes it.

### 4. Start FalkorDB with Docker Compose

Create the named volume once, then start the pinned FalkorDB service:

```powershell
npm run db:volume
npm run db:up
npm run db:status
```

[`compose.yaml`](./compose.yaml) publishes FalkorDB on the localhost-bound `FALKORDB_PORT`, checks readiness with `redis-cli ping`, restarts the container unless explicitly stopped, and mounts the external `FALKORDB_VOLUME` at `/var/lib/falkordb/data`, the database's configured storage directory. The external volume is intentional: `docker compose down` removes the container but preserves graph data. Do not use `docker compose down -v` or `docker volume rm` for the demo graph.

To stop without removing the container:

```powershell
npm run db:stop
```

To remove only the Compose container while preserving the volume:

```powershell
npm run db:down
```

### 5. Verify database reachability

The repository includes a direct connection smoke test:

```powershell
npx tsx .\src\graph\test-connection.ts
```

This test creates a `ConnectionTest` node in the selected graph, so it is a
write smoke test rather than a read-only health check. The module closes the
FalkorDB connection in a `finally` block. Set `FALKORDB_GRAPH` first if the
smoke-test node should be written to a separate development graph.

You can also verify that the container is running:

```powershell
npm run db:status
Test-NetConnection 127.0.0.1 -Port 6379
```

### 6. Initialize and validate the graph schema

Schema setup is implemented but is not registered as an npm script and is not
run automatically. Run the exported initializer directly with `tsx`:

```powershell
npx tsx --eval "import { initializeSchema } from './src/graph/schema.ts'; (async () => { await initializeSchema(); })();"
```

Validate the resulting metadata:

```powershell
npx tsx --eval "import { validateSchema } from './src/graph/schema.ts'; (async () => { console.log(await validateSchema()); })();"
```

Initialization is designed to be idempotent. It creates only missing
indexes/constraints, polls their FalkorDB metadata status, and does not drop
schema objects or delete graph data.

The graph name is selected when the Node process starts. All graph modules use
the shared `graphName` export from
[`src/graph/client.ts`](./src/graph/client.ts), so schema setup, ingestion,
inspection, and reusable graph operations target the same selected graph.

FalkorDB creates a graph lazily when the first graph write or schema operation
uses its name; the client does not require a separate graph-creation API.
To create and initialize a separate clean development graph, set its name in
the current PowerShell session before running the initializer:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"
npx tsx --eval "import { initializeSchema } from './src/graph/schema.ts'; (async () => { await initializeSchema(); })();"
npx tsx --eval "import { validateSchema } from './src/graph/schema.ts'; (async () => { console.log(await validateSchema()); })();"
```

Then ingest this repository into that graph:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"
npm run ingest
```

These commands address only `DebugGraphDev`; they do not delete, migrate, or
modify nodes and relationships in `DebugGraph`. To switch back:

```powershell
$env:FALKORDB_GRAPH = "DebugGraph"
```

For a one-off command without changing the rest of the session:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"; npm run ingest
```

### 7. Type-check the project

```powershell
npx tsc --noEmit
```

The compiler is configured by [`tsconfig.json`](./tsconfig.json) with strict
type checking and no emitted JavaScript.

### 8. Run project ingestion

Ingest the current repository:

```powershell
npm run ingest
```

The CLI accepts an optional first argument. To ingest another local
TypeScript/JavaScript repository:

```powershell
npm run ingest -- "C:\path\to\another\repository"
```

If omitted, the CLI uses the current working directory. It prints counts for
parsed files, symbols, local import records, and resolved calls. It does not
delete stale graph nodes or relationships.

### 9. Inspect the graph browser

The repository has no browser configuration file, but a FalkorDB browser
container can be run separately:

```powershell
docker run -d --name debuggraph-browser `
  -p 3000:3000 `
  falkordb/falkordb-browser:latest
```

Open <http://localhost:3000>. Browser connection details depend on the
browser image's current UI; use the FalkorDB server at `127.0.0.1:6379` and
the value of `FALKORDB_GRAPH` (or `DebugGraph` when unset) when prompted.

## Daily development workflow

After initial setup, choose the graph explicitly for the session:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"
npm run db:up
npm run db:status
npx tsc --noEmit
npm run ingest
```

Omit the assignment, or set it to `DebugGraph`, to use the original default
graph. Set it again in each new PowerShell session.

To ingest another project, pass its absolute or relative path:

```powershell
npm run ingest -- "C:\work\my-project"
```

The parser normalizes stored repository-relative file paths to `/` separators.
Imports are persisted only when TypeScript resolves their target to one of the
scanned files; external package imports are not written as `IMPORTS` edges.

There is currently no development server command. The available executable
entry points and package scripts are:

```powershell
npm run db:up
npm run db:status
npm run db:logs
npm run db:stop
npm run db:down
npm run ingest
npm run diagnostics
npm run context -- .
npm run history -- show <session-id>
npm run investigate -- <diagnostic-id>
npm run mcp
npm test
npx tsx .\src\graph\test-connection.ts
npx tsx --eval "import { initializeSchema, validateSchema } from './src/graph/schema.ts'; (async () => { await initializeSchema(); console.log(await validateSchema()); })();"
```

Run a compiler diagnostic scan for the current repository:

```powershell
npm run diagnostics
```

The CLI accepts the same optional repository root argument as code ingestion:

```powershell
npm run diagnostics -- "C:\path\to\another\repository"
```

It records an empty scan as a completed `Session` when the compiler reports no
diagnostics. It prints the scan summary followed by the latest scan's
diagnostic rows as JSON. Run it twice to preserve two scan sessions; stable
diagnostic IDs prevent duplicate diagnostic nodes.

Retrieve bounded graph-backed context for the latest scan:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"
npm run context -- .
```

To retrieve one historical diagnostic by ID, pass the ID after the repository
root:

```powershell
npm run context -- . "<diagnostic-id>"
```

The context command returns readable JSON containing the diagnostic, its
source file and inferred containing symbol when those relationships exist,
symbols declared in the file, locally imported files and their symbols, and
direct callers and callees. Retrieval is intentionally bounded to 10 latest
diagnostics, 50 symbols in the affected file, 20 imported files, 20 symbols
per imported file, and 25 callers and callees per containing symbol. Calls are
one-hop traversals; relationship direction and direct versus inferred
provenance are retained in the output. A project-level diagnostic or a
diagnostic whose source associations are absent still returns valid diagnostic
metadata with unavailable context arrays.

Representative output shape:

```json
{
  "rootDir": "C:/work/my-project",
  "contexts": [
    {
      "diagnostic": {
        "id": "<diagnostic-id>",
        "severity": "error",
        "code": 2322,
        "message": "Type 'number' is not assignable to type 'string'."
      },
      "items": [],
      "relationships": [],
      "metadata": {
        "graphName": "DebugGraphDev",
        "counts": { "items": 0, "files": 0, "symbols": 0, "relationships": 0 }
      }
    }
  ]
}
```

## Debugging history

The history layer records debugging activity without changing the approved
schema. It uses `Session` for a debugging session and the existing
`Hypothesis`, `DebugAttempt`, `Patch`, and `Evidence` labels. Its relationship
types are:

- `Session-[:TARGETS]->Diagnostic`
- `Session-[:HAS_HYPOTHESIS]->Hypothesis`
- `Session-[:HAS_ATTEMPT]->DebugAttempt`
- `Hypothesis-[:TESTED_BY]->DebugAttempt`
- `DebugAttempt-[:FOLLOWS]->DebugAttempt`
- `DebugAttempt-[:APPLIES]->Patch`
- `Hypothesis-[:HAS_PATCH]->Patch`
- `DebugAttempt-[:HAS_EVIDENCE]->Evidence`
- `Evidence-[:SUPPORTS|CONTRADICTS|VALIDATES]->Hypothesis`

All history writes are parameterized and preserve records. Sessions are reused by an explicit `sessionId`, or by a stable identity
including diagnostic ID, normalized goal, and baseline revision when one is
not supplied. Reusing an explicit session with conflicting identity metadata
is rejected. Hypotheses are session-scoped and use stable identities;
attempts require an explicit `attemptId` for repeatable writes and enforce one
attempt per sequence number within a session. Out-of-order attempts link the
immediate predecessor and successor when both exist. Repeated equivalent
writes use `MERGE`; conflicting immutable patch or evidence metadata is
rejected. Patch status is first-write-wins rather than an in-place lifecycle
update. Attempt outcomes and result summaries are write-once: repeating the
same outcome is safe, while a conflicting outcome or summary is rejected
instead of overwriting history. An `unevaluated` outcome does not imply
success or failure.

The `diagnosticId` on a debugging session is optional. A session created
without it is project-level history: its attempts and evidence remain
retrievable through that session, but they are not included in
diagnostic-targeted investigation history. A successful project-level
verification such as `npx tsc --noEmit` is historical evidence only; exit code
zero does not create a `TARGETS` relationship or resolve a historical
diagnostic.

Select the development graph and create a session linked to an existing
diagnostic:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"
npm run history -- session '{"sessionId":"phase4-session","diagnosticId":"<diagnostic-id>","goal":"Investigate compiler diagnostic","baselineRevision":"DebugGraphDev"}'
```

Record a hypothesis and ordered attempts:

```powershell
npm run history -- hypothesis '{"sessionId":"phase4-session","statement":"The return type is incompatible.","provenanceKind":"manual","rootCauseCategory":"type_contract"}'
npm run history -- attempt '{"sessionId":"phase4-session","hypothesisId":"<hypothesis-id>","attemptId":"attempt-1","sequenceNo":1,"status":"completed","testCommand":"npx tsc --noEmit"}'
npm run history -- attempt '{"sessionId":"phase4-session","hypothesisId":"<hypothesis-id>","attemptId":"attempt-2","sequenceNo":2,"status":"completed","testCommand":"npx tsc --noEmit"}'
npm run history -- outcome '{"attemptId":"attempt-1","outcome":"failed","resultSummary":"The diagnostic remains."}'
npm run history -- outcome '{"attemptId":"attempt-2","outcome":"unevaluated","resultSummary":"No success claimed yet."}'
```

Attach a patch or evidence only when its provenance supports the recorded
relationship:

```powershell
npm run history -- patch '{"attemptId":"attempt-1","hypothesisId":"<hypothesis-id>","patchHash":"<hash>","status":"proposed","diffSummary":"Candidate change","diffRef":"review://patch-1"}'
npm run history -- evidence '{"attemptId":"attempt-1","hypothesisId":"<hypothesis-id>","kind":"compiler_diagnostic","result":"failed","summary":"The compiler still reports the diagnostic.","sourceKind":"compiler","sourceRef":"<diagnostic-id>","relationToHypothesis":"SUPPORTS"}'
```

Retrieve bounded deterministic history:

```powershell
npm run history -- show phase4-session
```

History retrieval limits results to 100 hypotheses, 100 attempts, 200 patches,
and 300 evidence records. Attempts are ordered by sequence, start time, and
ID; other records use timestamp and ID ordering. Empty and partially populated
sessions are valid.

## Evidence-based investigation

The read-only investigation assembler combines the current diagnostic context
with bounded histories linked through `Session-[:TARGETS]->Diagnostic`:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"
npm run investigate -- "<diagnostic-id>"
```

The result keeps current facts, code context, recorded hypotheses, historical
outcomes, evidence, and derived recommendations in separate fields. A failed
historical attempt is reported as historical evidence, not as proof that the
current diagnostic still fails. Unevaluated attempts and missing evidence
produce an explicit request for further diagnostic or test evidence. Each
recommendation includes supporting record IDs, relevant context IDs, a reason,
and uncertainty.

Only sessions explicitly connected through `Session-[:TARGETS]->Diagnostic`
are included in a diagnostic-specific investigation. Project-level verification
must not be treated as evidence for a particular diagnostic unless a separate
association is explicitly established from matching provenance.

The investigation context also exposes read-only evidence reconciliation. It
marks evidence from an explicit `TARGETS` session as diagnostic-associated,
reports evidence from sessions without that relationship as
project-level-uncertain, and marks conflicting target provenance as uncertain.
The latest completed compiler scan is reported separately, so a historical
diagnostic absent from that scan is not presented as currently detected.

Investigation retrieval is bounded to the 20 most recent associated sessions
and 100 attempts per session by default. Session selection is deterministic by
descending start time and ID. The `test` script runs focused recommendation
tests with Node's built-in test runner.

## Read-only MCP integration

The local MCP server exposes exactly one read-only stdio tool,
`debuggraph_investigate`. It delegates to the same assembler as the
`investigate` CLI and preserves the complete structured JSON result, including
provenance, evidence relationships, supporting IDs, and recommendation
uncertainty.

Run it from an MCP client with:

```powershell
$env:FALKORDB_GRAPH = "DebugGraphDev"
node --import tsx src/mcp-server.ts
```

The equivalent convenience command is `npm run mcp`; when configuring an MCP
client, prefer the direct `node --import tsx src/mcp-server.ts` command (or an
equivalent silent process launcher) so the launcher cannot write notices to
stdout. The server itself sends diagnostics to stderr and reserves stdout for
MCP protocol traffic.

The required tool input is `diagnosticId`. Optional inputs are
`maxSessions`, `maxAttemptsPerSession`, and a `context` object containing the
existing traversal limits (`maxDiagnostics`, `maxFileSymbols`,
`maxImportedFiles`, `maxImportedFileSymbols`, `maxCallers`, and `maxCallees`).
The server performs no graph writes. Missing diagnostics, connection failures,
validation failures, and unexpected errors are returned as MCP tool errors.

The existing defaults remain unchanged: 20 sessions, 100 attempts per session,
10 diagnostics, 50 file symbols, 20 imported files, 20 symbols per imported
file, and 25 callers or callees. Shared hard maximums reject larger requests:
50 sessions, 500 attempts per session, 50 diagnostics, 200 file symbols, 100
imported files, 100 symbols per imported file, and 100 callers or callees.
These limits bound history fan-out and the per-file/import/call traversal while
allowing larger local investigations than the defaults; oversized values fail
with a validation error rather than being silently truncated.

Run the focused tests with:

```powershell
npm test
```

## Hackathon demo checklist

Use a dedicated graph so the demo cannot mix with an existing `DebugGraph`:

```powershell
$env:FALKORDB_HOST = "127.0.0.1"
$env:FALKORDB_PORT = "6379"
$env:FALKORDB_GRAPH = "DebugGraphDev"
npm run db:volume
npm run db:up
npx tsx --eval "import { initializeSchema } from './src/graph/schema.ts'; (async () => { await initializeSchema(); })();"
npm run ingest
npm run diagnostics
```

The diagnostic command prints each latest-scan row with its `diagnosticId`.
Choose one reported ID for the investigation step. If the clean checkout has
no compiler diagnostics, use a known diagnostic ID already present in the
dedicated demo graph or demonstrate the latest-scan `0 diagnostics` result.

To demonstrate read-only investigation and reconciliation:

```powershell
$diagnosticId = "<diagnostic-id-from-diagnostics-output>"
npm run investigate -- $diagnosticId
```

For a repeatable project-level verification record, use stable IDs and do not
provide `diagnosticId` when creating the session:

```powershell
npm run history -- session '{"sessionId":"demo-project-verification","goal":"Demo project verification","baselineRevision":"demo"}'
npm run history -- hypothesis '{"sessionId":"demo-project-verification","statement":"The project compiles","provenanceKind":"demo"}'
npm run history -- attempt '{"sessionId":"demo-project-verification","hypothesisId":"<hypothesis-id>","attemptId":"demo-project-tsc","sequenceNo":1,"status":"completed","testCommand":"npx tsc --noEmit"}'
npm run history -- outcome '{"attemptId":"demo-project-tsc","outcome":"successful","resultSummary":"The compiler completed successfully."}'
npm run history -- evidence '{"attemptId":"demo-project-tsc","kind":"compiler_verification","result":"passed","summary":"npx tsc --noEmit completed successfully.","sourceKind":"compiler","sourceRef":"demo","testName":"npx tsc --noEmit","exitCode":0,"hypothesisId":"<hypothesis-id>","relationToHypothesis":"CONTRADICTS"}'
npm run investigate -- $diagnosticId
```

The result keeps this project-level evidence in the reconciliation section as
`project-level-uncertain`; it does not create a `TARGETS` relationship or mark
the diagnostic resolved. A session created with `diagnosticId` explicitly
supplied demonstrates `diagnostic-associated` evidence. The MCP response is
the same assembled JSON and is read-only:

```json
{
  "mcpServers": {
    "debuggraph": {
      "command": "node",
      "args": ["--import", "tsx", "src/mcp-server.ts"],
      "env": {
        "FALKORDB_HOST": "127.0.0.1",
        "FALKORDB_PORT": "6379",
        "FALKORDB_GRAPH": "DebugGraphDev"
      }
    }
  }
}
```

Keep this client registration local. The repository ignores
`.mcp.json` and `.vscode/mcp.json` because MCP configuration is
machine-specific.

Stop local containers when finished:

```powershell
npm run db:stop
```

## Graph schema

The graph selected by the application is `FALKORDB_GRAPH`, defaulting to
`DebugGraph` when the variable is unset or blank.

### Labels and schema support

[`src/graph/schema.ts`](./src/graph/schema.ts) defines these labels:

`Service`, `File`, `Symbol`, `Type`, `APIEndpoint`, `Diagnostic`, `Session`,
`DebugAttempt`, `Hypothesis`, `Patch`, and `Evidence`.

Every label has a range index on `id` and a unique constraint on `id`.
Additional indexes are defined for:

| Label | Additional indexes |
| --- | --- |
| `File` | `filePath` |
| `Symbol` | `qualifiedName`, `filePath` |
| `Type` | `qualifiedName`, `shapeHash` |
| `APIEndpoint` | composite `(method, path)` |
| `Diagnostic` | `fingerprint`, `observedAt` |
| `Session` | `problemFingerprint`, `startedAt` |
| `DebugAttempt` | `attemptFingerprint`, `sequenceNo` |
| `Hypothesis` | `hypothesisFingerprint` |
| `Patch` | `patchHash` |
| `Evidence` | `observedAt`, `kind` |

`File.filePath` also has a unique constraint. Other fingerprints, hashes,
timestamps, and sequence numbers are not declared unique by the current
schema. Temporal ordering and per-session sequence invariants therefore
remain application-level concerns.

The current ingestion pipeline writes `Service`, `File`, and `Symbol` nodes.
The history CLI writes the debugging-related labels and relationships described
in [Debugging history](#debugging-history); autonomous repair is not part of
those writes.

### Implemented relationships

The ingestion pipeline persists these directed relationships:

- `(:Service)-[:CONTAINS_FILE]->(:File)` — files belonging to the ingested
  repository service.
- `(:File)-[:CONTAINS]->(:Symbol)` — symbols declared in a file.
- `(:File)-[:IMPORTS]->(:File)` — local import declarations whose targets were
  resolved inside the scanned repository.
- `(:Symbol)-[:CALLS]->(:Symbol)` — calls resolved by the TypeScript checker to
  scanned repository declarations. Each relationship stores a positive
  one-based `callSiteLine` when ingested.
- `(:Session)-[:TARGETS]->(:Diagnostic)` — compiler diagnostics reported by a
  timestamped diagnostic scan.
- `(:Diagnostic)-[:LOCATED_IN]->(:File)` — source file location when the
  compiler supplied a source file.
- `(:Diagnostic)-[:LOCATED_IN]->(:Symbol)` — inferred nearest containing
  symbol when the diagnostic has a usable source position.

Relationships use `MERGE`, so equivalent repeated ingestion does not create
duplicate edges. Relationship creation records `createdAt` and
`sourceKind: "static_analysis"` where applicable. Existing nodes and edges
are not automatically removed when source files disappear.

### Useful FalkorDB queries

The examples below use the `DebugGraph` graph in the FalkorDB browser or any
compatible Cypher client:

```cypher
MATCH (n)
RETURN labels(n) AS labels, count(n) AS count
```

```cypher
MATCH ()-[r]->()
RETURN type(r) AS relationshipType, count(r) AS count
```

```cypher
MATCH (f:File)-[:CONTAINS]->(s:Symbol)
RETURN f.filePath AS filePath, count(s) AS symbolCount
ORDER BY filePath
```

```cypher
MATCH (f:File)-[:IMPORTS]->(target:File)
RETURN f.filePath AS source, target.filePath AS target
ORDER BY source, target
```

```cypher
MATCH (caller:Symbol)-[r:CALLS]->(callee:Symbol)
RETURN caller.qualifiedName AS caller,
       callee.qualifiedName AS callee,
       r.callSiteLine AS callSiteLine
ORDER BY caller, callSiteLine
LIMIT 100
```

```cypher
MATCH (session:Session)-[:TARGETS]->(diagnostic:Diagnostic)
WHERE session.goal = 'compiler diagnostic scan'
RETURN session.startedAt AS scanStartedAt,
       diagnostic.severity AS severity,
       diagnostic.code AS code,
       diagnostic.message AS message,
       diagnostic.filePath AS filePath,
       diagnostic.lineNumber AS lineNumber,
       diagnostic.columnNumber AS columnNumber
ORDER BY scanStartedAt DESC, filePath, lineNumber
LIMIT 100
```

To query the latest scan for one repository root, first select the newest
completed session for that root and then traverse its `TARGETS` edges:

```cypher
MATCH (session:Session)
WHERE session.goal = 'compiler diagnostic scan'
  AND session.baselineRevision = $rootDir
WITH max(session.startedAt) AS latestStartedAt
MATCH (session:Session)-[:TARGETS]->(diagnostic:Diagnostic)
WHERE session.goal = 'compiler diagnostic scan'
  AND session.baselineRevision = $rootDir
  AND session.startedAt = latestStartedAt
RETURN session.id AS sessionId,
       diagnostic.severity AS severity,
       diagnostic.code AS code,
       diagnostic.message AS message,
       diagnostic.filePath AS filePath,
       diagnostic.lineNumber AS lineNumber,
       diagnostic.columnNumber AS columnNumber
ORDER BY diagnostic.filePath, diagnostic.lineNumber
```

```cypher
MATCH (s:Service {id: $serviceId})-[:CONTAINS_FILE]->(f:File)
RETURN s.id AS serviceId, f.filePath AS filePath, f.language AS language
ORDER BY f.filePath
```

The last query is parameterized in application code by
[`listFilesForService`](./src/graph/inspection.ts).

## Repository structure

```text
.
├── .env.example              # FalkorDB connection and graph template
├── .gitignore                # Local/build exclusions
├── compose.yaml              # Pinned FalkorDB service and persistent volume
├── package.json              # Dependencies and CLI/database scripts
├── package-lock.json         # Locked npm dependency tree
├── tsconfig.json             # Strict TypeScript configuration
├── examples/                 # Currently empty
├── tests/                    # Node test-runner coverage
└── src/
    ├── index.ts              # Minimal startup message
    ├── ingest-cli.ts         # CLI entry point for project ingestion
    ├── diagnostic-cli.ts     # CLI entry point for compiler diagnostics
    ├── context-cli.ts        # CLI entry point for graph context retrieval
    ├── history-cli.ts        # CLI entry point for debugging history
    ├── investigate-cli.ts    # Evidence-based debugging context assembler
    ├── mcp-server.ts         # Read-only stdio MCP server
    ├── graph/
    │   ├── client.ts         # FalkorDB connection and environment-selected graph
    │   ├── ingest.ts         # ParsedProject-to-graph persistence
    │   ├── inspection.ts     # Read helper for service files
    │   ├── operations.ts     # Reusable service/file upsert
    │   ├── schema.ts         # Schema definitions, initialization, validation
    │   └── test-connection.ts# Write-based connection smoke test
    ├── parser/
    │   └── project-parser.ts # TypeScript compiler API parser
    └── diagnostics/
        └── diagnostic-ingest.ts # Compiler diagnostics and latest-scan queries
    └── debugging/
        ├── context-retrieval.ts # Bounded diagnostic context traversal
        ├── context-assembler.ts # Read-only current and historical context
        └── history.ts            # Debugging sessions and evidence history
```

## Continuing development

Prioritize changes in this order:

1. Keep ingestion, diagnostic scanning, bounded context retrieval, and history
   operations accurate, idempotent, and testable.
2. Expand compiler diagnostic coverage and retrieval, including richer
   configuration and source associations.
3. Improve evidence reconciliation and repeated-failure detection while
   preserving conservative uncertainty handling.
4. Add API endpoint and cross-service type-contract tracing.
5. Integrate the graph with a VS Code debugging interface.
6. Design and implement autonomous code repair only after the investigation
   and evidence contracts are sufficiently mature.

These are planned milestones, not current capabilities.

For each feature, follow this development pattern:

1. Inspect the existing schema and module APIs.
2. Implement one cohesive capability without changing unrelated modules.
3. Use parameterized queries and strict result-shape validation.
4. Preserve `finally`-based FalkorDB connection cleanup.
5. Run `npx tsc --noEmit` and the focused Node test suite with `npm test`.
6. Verify idempotency against a development graph.
7. Update this README only after behavior and commands are actually available.

## Troubleshooting

### Docker is not running

Start Docker Desktop, then check:

```powershell
docker version
docker ps
```

If `docker version` cannot reach the daemon, FalkorDB containers cannot start.

### Connection refused

Confirm that the database container is running and that port `6379` is
published:

```powershell
docker ps --filter "name=debuggraph-db"
Test-NetConnection 127.0.0.1 -Port 6379
```

Start the service with `npm run db:up`, or inspect its health with
`npm run db:status`. Use `npm run db:logs` for startup diagnostics.

### Incorrect host or port

The client reads `FALKORDB_HOST` and `FALKORDB_PORT` at process startup. Check
the current PowerShell values:

```powershell
Get-ChildItem Env:FALKORDB_HOST, Env:FALKORDB_PORT
```

Set them before running `tsx` or npm commands:

```powershell
$env:FALKORDB_HOST = "127.0.0.1"
$env:FALKORDB_PORT = "6379"
```

### `.env` is missing or has no effect

Copy `.env.example` only when `.env` does not already exist. The current source
does not load dotenv files, so values in `.env` alone are not automatically
exported into the Node process. Set the variables in PowerShell as shown
above.

### TypeScript compiler API errors

Keep TypeScript at `5.9.3`, which is the version declared in
[`package.json`](./package.json) and used by
[`project-parser.ts`](./src/parser/project-parser.ts). If dependencies were
changed, restore the lockfile installation with:

```powershell
npm ci
npx tsc --noEmit
```

Do not switch to TypeScript 7 without adapting the parser to its different
compiler API exports.

### Schema initialization or validation fails

First confirm the database connection, then inspect metadata in FalkorDB:

```cypher
CALL db.indexes()
```

```cypher
CALL db.constraints()
```

The initializer waits for indexes and unique constraints to reach
`OPERATIONAL`; failed or unexpected statuses are reported as errors. It does
not drop existing objects or repair arbitrary pre-existing schema definitions.

### Ingestion appears to create duplicates or stale records

Ingestion is designed to be repeatable: rerun it and compare node and
relationship counts. It uses deterministic IDs and `MERGE`. It intentionally
does not delete nodes or edges for files that no longer exist, so stale records
can remain after source removal. Existing development or smoke-test records
also contribute to aggregate counts.

### The FalkorDB browser cannot connect

Check that the browser container is running and port `3000` is published:

```powershell
docker ps --filter "name=debuggraph-browser"
Test-NetConnection 127.0.0.1 -Port 3000
```

Open <http://localhost:3000> and configure the browser to reach the FalkorDB
server on `127.0.0.1:6379` if the UI requests a connection. The repository
does not manage browser configuration.
