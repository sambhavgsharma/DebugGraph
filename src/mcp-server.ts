import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  assembleDebugContext,
  type AssembledDebugContext,
  type AssemblerLimits,
} from "./debugging/context-assembler";
import {
  MAX_CONTEXT_LIMITS,
  MAX_MAX_ATTEMPTS_PER_SESSION,
  MAX_MAX_SESSIONS,
} from "./debugging/limits";

const contextLimitsSchema = z.object({
  maxDiagnostics: z.number().int().positive().max(MAX_CONTEXT_LIMITS.maxDiagnostics).optional(),
  maxFileSymbols: z.number().int().positive().max(MAX_CONTEXT_LIMITS.maxFileSymbols).optional(),
  maxImportedFiles: z.number().int().positive().max(MAX_CONTEXT_LIMITS.maxImportedFiles).optional(),
  maxImportedFileSymbols: z.number().int().positive().max(MAX_CONTEXT_LIMITS.maxImportedFileSymbols).optional(),
  maxCallers: z.number().int().positive().max(MAX_CONTEXT_LIMITS.maxCallers).optional(),
  maxCallees: z.number().int().positive().max(MAX_CONTEXT_LIMITS.maxCallees).optional(),
}).strict();

export const investigateInputSchema = {
  diagnosticId: z.string(),
  maxSessions: z.number().int().positive().max(MAX_MAX_SESSIONS).optional(),
  maxAttemptsPerSession: z.number().int().positive().max(MAX_MAX_ATTEMPTS_PER_SESSION).optional(),
  context: contextLimitsSchema.optional(),
};

export type InvestigateToolInput = {
  readonly diagnosticId: string;
  readonly maxSessions?: number;
  readonly maxAttemptsPerSession?: number;
  readonly context?: AssemblerLimits["context"];
};

export type AssembleDebugContext = (
  diagnosticId: string,
  limits?: AssemblerLimits,
) => Promise<AssembledDebugContext>;

export function createMcpServer(
  assemble: AssembleDebugContext = assembleDebugContext,
): McpServer {
  const server = new McpServer({
    name: "debuggraph",
    version: "1.0.0",
  });
  server.registerTool(
    "debuggraph_investigate",
    {
      title: "Investigate a compiler diagnostic",
      description:
        "Read-only, bounded retrieval of current diagnostic context and associated debugging history.",
      inputSchema: investigateInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input: InvestigateToolInput) => {
      if (input.diagnosticId.trim().length === 0) {
        throw new Error("diagnosticId must not be blank");
      }
      const result = await assemble(input.diagnosticId, {
        maxSessions: input.maxSessions,
        maxAttemptsPerSession: input.maxAttemptsPerSession,
        context: input.context,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );
  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error("DebugGraph MCP transport error:", error);
  };
  await server.connect(transport);
}

if (require.main === module) {
  startMcpServer().catch((error: unknown) => {
    console.error(
      "DebugGraph MCP server failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
