import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools.js";
import { registerAllResources } from "./resources.js";

export function createAntigravityMcpServer(): McpServer {
  const server = new McpServer({
    name: "antigravity-mcp-bridge",
    version: "0.1.0",
  });

  registerAllTools(server);
  registerAllResources(server);

  return server;
}
