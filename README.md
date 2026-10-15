# DebugGraph

DebugGraph is a graph-powered debugging foundation for AI coding agents. Its
long-term goal is to connect code structure, diagnostics, debugging
hypotheses, patches, attempts, test results, and evidence so an agent can
trace possible causes and avoid repeating unsuccessful experiments without new
evidence.

The current repository implements the first code-ingestion slice of that
architecture. It parses a TypeScript/JavaScript repository and persists its
files, symbols, local imports, and resolved function calls in FalkorDB. The
debugging-session engine and autonomous repair workflow are not implemented
yet.

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
- Selection of the `DebugGraph` graph.
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

### Not implemented yet

- Diagnostic/compiler-error ingestion.
- Debugging sessions, hypotheses, patches, attempts, or evidence persistence.
- Graph-based context retrieval for an AI agent.
- API endpoint tracing or cross-service type-contract tracing.
- Repeated-failure detection and retry-prevention logic.
- A VS Code debugging interface or autonomous coding-agent workflow.
- Automatic schema initialization from an npm script.
- An application server or a configured automated test runner.

The graph may contain older development or smoke-test records. Counts from a
particular local database are snapshots, not project guarantees.

## Architecture

DebugGraph is intended to maintain two related graph views:

1. **Code structure** — services, files, symbols, imports, calls, and
   eventually API and type relationships.
2. **Debugging history** — diagnostic observations, sessions, hypotheses,
   patches, attempts, tests, and evidence.

The code currently implements only the first view's initial ingestion path.
Graph traversal is the planned mechanism for retrieving nearby code and,
later, relevant debugging history. Recorded outcomes are intended to support
evidence-based debugging and repeated-failure detection once those features
are built.

The ingestion flow is:

```text
repository root
    -> TypeScript compiler program and type checker
    -> ParsedProject
    -> parameterized FalkorDB MERGE/UNWIND writes
    -> DebugGraph
```

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

The current `.env` file is not loaded automatically by the application. If
you need values from it in a PowerShell session, load them explicitly or set
the environment variables in the session, for example:

```powershell
$env:FALKORDB_HOST = "127.0.0.1"
$env:FALKORDB_PORT = "6379"
```

Never commit `.env`. The repository's `.gitignore` excludes it.

### 4. Start FalkorDB

There is no Docker Compose file in this repository. A local setup can use the
official FalkorDB image with the ports expected by [the graph client](./src/graph/client.ts):

```powershell
docker run -d --name debuggraph-db `
  -p 6379:6379 `
  falkordb/falkordb:latest
```

This command creates a container without a host-mounted data volume. For
persistent local data, add a deliberately chosen Docker volume, for example:

```powershell
docker volume create debuggraph-data
docker run -d --name debuggraph-db `
  -p 6379:6379 `
  -v debuggraph-data:/data `
  falkordb/falkordb:latest
```

If a container with that name already exists, start it instead:

```powershell
docker start debuggraph-db
```

The repository does not define persistence or backup policy. Treat this as a
development database.

### 5. Verify database reachability

The repository includes a direct connection smoke test:

```powershell
npx tsx .\src\graph\test-connection.ts
```

This test creates a `ConnectionTest` node in `DebugGraph`, so it is a write
smoke test rather than a read-only health check. The module closes the
FalkorDB connection in a `finally` block.

You can also verify that the container is running:

```powershell
docker ps --filter "name=debuggraph-db"
Test-NetConnection 127.0.0.1 -Port 6379
```

### 6. Initialize and validate the graph schema

Schema setup is implemented but is not registered as an npm script and is not
run automatically. Run the exported initializer directly with `tsx`:

```powershell
npx tsx --eval "import { initializeSchema } from './src/graph/schema.ts'; await initializeSchema();"
```

Validate the resulting metadata:

```powershell
npx tsx --eval "import { validateSchema } from './src/graph/schema.ts'; console.log(await validateSchema());"
```

Initialization is designed to be idempotent. It creates only missing
indexes/constraints, polls their FalkorDB metadata status, and does not drop
schema objects or delete graph data.

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
the graph name `DebugGraph` when prompted.

## Daily development workflow

After initial setup:

```powershell
docker start debuggraph-db
npx tsc --noEmit
npm run ingest
```

To ingest another project, pass its absolute or relative path:

```powershell
npm run ingest -- "C:\work\my-project"
```

The parser normalizes stored repository-relative file paths to `/` separators.
Imports are persisted only when TypeScript resolves their target to one of the
scanned files; external package imports are not written as `IMPORTS` edges.

There is currently no development server command. The available executable
entry points are:

```powershell
npm run ingest
npx tsx .\src\graph\test-connection.ts
npx tsx --eval "import { initializeSchema, validateSchema } from './src/graph/schema.ts'; await initializeSchema(); console.log(await validateSchema());"
```

The `test` npm script is still a placeholder and intentionally fails:

```powershell
npm test
```

No test runner is configured yet. Stop local containers when finished:

```powershell
docker stop debuggraph-browser
docker stop debuggraph-db
```

## Graph schema

The graph selected by the application is `DebugGraph`.

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

The debugging-related labels are schema support only at present. The current
ingestion pipeline writes `Service`, `File`, and `Symbol` nodes.

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
MATCH (s:Service {id: $serviceId})-[:CONTAINS_FILE]->(f:File)
RETURN s.id AS serviceId, f.filePath AS filePath, f.language AS language
ORDER BY f.filePath
```

The last query is parameterized in application code by
[`listFilesForService`](./src/graph/inspection.ts).

## Repository structure

```text
.
├── .env.example              # FalkorDB connection variable template
├── .gitignore                # Local/build exclusions
├── package.json              # Dependencies and ingest script
├── package-lock.json         # Locked npm dependency tree
├── tsconfig.json             # Strict TypeScript configuration
├── examples/                 # Currently empty
├── tests/                    # Currently empty; no runner is configured
└── src/
    ├── index.ts              # Minimal startup message
    ├── ingest-cli.ts         # CLI entry point for project ingestion
    ├── graph/
    │   ├── client.ts         # FalkorDB connection and DebugGraph selection
    │   ├── ingest.ts         # ParsedProject-to-graph persistence
    │   ├── inspection.ts     # Read helper for service files
    │   ├── operations.ts     # Reusable service/file upsert
    │   ├── schema.ts         # Schema definitions, initialization, validation
    │   └── test-connection.ts# Write-based connection smoke test
    └── parser/
        └── project-parser.ts # TypeScript compiler API parser
```

## Continuing development

Prioritize changes in this order:

1. Keep ingestion accurate, idempotent, and testable. Add focused parser and
   persistence tests before changing identity or relationship semantics.
2. Capture real compiler/type-check diagnostics and associate them with files
   and symbols.
3. Build graph-based context retrieval across imports and calls.
4. Persist debugging sessions, hypotheses, patch attempts, evidence, and test
   outcomes using the existing schema definitions.
5. Implement repeated-failure detection that considers whether new evidence or
   relevant context justifies another attempt.
6. Add API endpoint and cross-service type-contract tracing.
7. Integrate the graph with a VS Code debugging interface or AI coding-agent
   workflow.

These are planned milestones, not current capabilities.

For each feature, follow this development pattern:

1. Inspect the existing schema and module APIs.
2. Implement one cohesive capability without changing unrelated modules.
3. Use parameterized queries and strict result-shape validation.
4. Preserve `finally`-based FalkorDB connection cleanup.
5. Run `npx tsc --noEmit` and focused tests once a test runner exists.
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

Start the container with `docker start debuggraph-db`, or create it using the
command in [Local setup](#4-start-falkordb).

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
