import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { toolWireSchema, type Tool } from "@oh-my-pi/pi-ai";

export function createToolBridge(tools: Tool[]): McpSdkServerConfigWithInstance {
  const instance = new McpServer({ name: "omp", version: "0.1.0" }, { capabilities: { tools: {} } });
  const definitions: McpTool[] = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { ...toolWireSchema(tool), type: "object" } as McpTool["inputSchema"],
    _meta: { "anthropic/alwaysLoad": true },
  }));
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  // The PreToolUse hook defers every call to OMP. Fail closed if the SDK ever
  // tries executing one here: approvals and filesystem access belong to OMP.
  instance.server.setRequestHandler(CallToolRequestSchema, async () => {
    throw new Error("OMP tool execution is not permitted inside Claude Agent SDK");
  });
  return { type: "sdk", name: "omp", instance };
}
