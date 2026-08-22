#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAntigravityMcpServer } from "./server.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const isHttp = args.includes("--http") || !!process.env.MCP_HTTP || process.env.MCP_TRANSPORT === "http";

async function main() {
  if (isHttp) {
    const host = process.env.MCP_HOST || "127.0.0.1";
    const port = parseInt(process.env.MCP_PORT || "3200", 10);
    const transports = new Map<string, StreamableHTTPServerTransport>();

    const httpServer = createServer(async (req, res) => {
      // CORS headers for local/remote dev environments
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-porta-target-app, Mcp-Session-Id");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

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

      if (req.url?.startsWith("/mcp") || req.url === "/") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              if (transport) transports.set(id, transport);
            },
            onsessionclosed: (id) => {
              transports.delete(id);
            },
          });
          const server = createAntigravityMcpServer();
          await server.connect(transport);
        }

        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    httpServer.listen(port, host, () => {
      console.error(`[antigravity-mcp-bridge] HTTP/SSE transport listening on http://${host}:${port}/mcp`);
    });
  } else {
    const mcpServer = createAntigravityMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("[antigravity-mcp-bridge] stdio transport connected");
  }
}

main().catch((err) => {
  console.error("[antigravity-mcp-bridge] Fatal startup error:", err);
  process.exit(1);
});
