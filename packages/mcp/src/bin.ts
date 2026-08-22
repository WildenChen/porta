#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAntigravityMcpServer } from "./server.js";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const isHttp = args.includes("--http") || !!process.env.MCP_HTTP || process.env.MCP_TRANSPORT === "http";

async function main() {
  const mcpServer = createAntigravityMcpServer();

  if (isHttp) {
    const host = process.env.MCP_HOST || "127.0.0.1";
    const port = parseInt(process.env.MCP_PORT || "3200", 10);

    // In stateless mode, session validation is not required for incoming requests
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);

    const httpServer = createServer((req, res) => {
      // CORS headers for local/remote dev environments
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-porta-target-app");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/health" || req.url === "/ping") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "antigravity-mcp-bridge" }));
        return;
      }

      if (req.url === "/mcp" || req.url === "/") {
        void transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    httpServer.listen(port, host, () => {
      console.error(`[antigravity-mcp-bridge] HTTP/SSE transport listening on http://${host}:${port}/mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("[antigravity-mcp-bridge] stdio transport connected");
  }
}

main().catch((err) => {
  console.error("[antigravity-mcp-bridge] Fatal startup error:", err);
  process.exit(1);
});
