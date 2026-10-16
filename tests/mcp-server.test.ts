import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpServer,
  type AssembleDebugContext,
} from "../src/mcp-server";
import type { AssembledDebugContext } from "../src/debugging/context-assembler";
import {
  MAX_CONTEXT_LIMITS,
  MAX_MAX_ATTEMPTS_PER_SESSION,
  MAX_MAX_SESSIONS,
} from "../src/debugging/limits";

const assembled: AssembledDebugContext = {
  diagnostic: {
    id: "diagnostic-1",
    severity: "error",
    code: 2322,
    message: "Type is not assignable",
  },
  codeContext: {
    diagnostic: {
      id: "diagnostic-1",
      severity: "error",
      code: 2322,
      message: "Type is not assignable",
    },
    items: [],
    relationships: [],
    metadata: {
      graphName: "DebugGraphDev",
      diagnosticId: "diagnostic-1",
      counts: { items: 0, files: 0, symbols: 0, relationships: 0 },
      limits: {
        maxDiagnostics: 10,
        maxFileSymbols: 50,
        maxImportedFiles: 20,
        maxImportedFileSymbols: 20,
        maxCallers: 25,
        maxCallees: 25,
      },
    },
  },
  historicalSessions: [],
  facts: [],
  hypotheses: [],
  outcomes: [],
  evidence: [],
  recommendations: [],
  metadata: {
    graphName: "DebugGraphDev",
    diagnosticId: "diagnostic-1",
    limits: { maxSessions: 20, maxAttemptsPerSession: 100 },
  },
};

async function connectedServer(assemble: AssembleDebugContext = async () => assembled) {
  const server = createMcpServer(assemble);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("registers exactly the investigation tool with required diagnosticId", async () => {
  const { server, client } = await connectedServer();
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["debuggraph_investigate"]);
    const tool = listed.tools[0];
    assert.deepEqual(tool.inputSchema.required, ["diagnosticId"]);
    assert.ok(tool.inputSchema.properties?.diagnosticId);
  } finally {
    await client.close();
    await server.close();
  }
});

test("valid requests delegate and preserve the complete assembler result", async () => {
  const calls: unknown[] = [];
  const { server, client } = await connectedServer(async (diagnosticId, limits) => {
    calls.push({ diagnosticId, limits });
    return assembled;
  });
  try {
    const result = await client.callTool({
      name: "debuggraph_investigate",
      arguments: {
        diagnosticId: "diagnostic-1",
        maxSessions: MAX_MAX_SESSIONS,
        maxAttemptsPerSession: MAX_MAX_ATTEMPTS_PER_SESSION,
        context: MAX_CONTEXT_LIMITS,
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), assembled);
    assert.deepEqual(calls, [{
      diagnosticId: "diagnostic-1",
      limits: {
        maxSessions: MAX_MAX_SESSIONS,
        maxAttemptsPerSession: MAX_MAX_ATTEMPTS_PER_SESSION,
        context: MAX_CONTEXT_LIMITS,
      },
    }]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("rejects invalid and over-maximum limits", async () => {
  const { server, client } = await connectedServer();
  try {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of invalidValues) {
      const result = await client.callTool({
        name: "debuggraph_investigate",
        arguments: { diagnosticId: "diagnostic-1", maxSessions: value },
      });
      assert.equal(result.isError, true);
    }

    const overMaximum = await client.callTool({
      name: "debuggraph_investigate",
      arguments: {
        diagnosticId: "diagnostic-1",
        maxAttemptsPerSession: MAX_MAX_ATTEMPTS_PER_SESSION + 1,
      },
    });
    assert.equal(overMaximum.isError, true);

    const invalidNestedType = await client.callTool({
      name: "debuggraph_investigate",
      arguments: {
        diagnosticId: "diagnostic-1",
        context: { maxImportedFiles: "20" },
      },
    });
    assert.equal(invalidNestedType.isError, true);

    const overMaximumNested = await client.callTool({
      name: "debuggraph_investigate",
      arguments: {
        diagnosticId: "diagnostic-1",
        context: { maxCallers: MAX_CONTEXT_LIMITS.maxCallers + 1 },
      },
    });
    assert.equal(overMaximumNested.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("blank and invalid diagnostic IDs return tool errors", async () => {
  const { server, client } = await connectedServer();
  try {
    const blank = await client.callTool({
      name: "debuggraph_investigate",
      arguments: { diagnosticId: "   " },
    });
    assert.equal(blank.isError, true);
    assert.match((blank.content[0] as { text: string }).text, /must not be blank/);

    const invalid = await client.callTool({
      name: "debuggraph_investigate",
      arguments: { diagnosticId: 42 },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("missing and unexpected assembler errors remain tool errors", async () => {
  const missing = await connectedServer(async () => {
    throw new Error('Diagnostic "missing" was not found');
  });
  try {
    const result = await missing.client.callTool({
      name: "debuggraph_investigate",
      arguments: { diagnosticId: "missing" },
    });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /Diagnostic "missing" was not found/);
  } finally {
    await missing.client.close();
    await missing.server.close();
  }

  const unexpected = await connectedServer(async () => {
    throw new Error("FalkorDB connection failed");
  });
  try {
    const result = await unexpected.client.callTool({
      name: "debuggraph_investigate",
      arguments: { diagnosticId: "diagnostic-1" },
    });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /FalkorDB connection failed/);
  } finally {
    await unexpected.client.close();
    await unexpected.server.close();
  }
});

test("adapter does not expose a graph-writing path", async () => {
  let calls = 0;
  const { server, client } = await connectedServer(async () => {
    calls += 1;
    return assembled;
  });
  try {
    await client.callTool({
      name: "debuggraph_investigate",
      arguments: { diagnosticId: "diagnostic-1" },
    });
    assert.equal(calls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
