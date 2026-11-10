#!/usr/bin/env node
/**
 * MCP server for Shop Demo.
 * Serves stdio by default, Streamable HTTP when TRANSPORT=http.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { assertConfigured, callOperation } from "./api.js";
import { auditLog, enabledTools, httpSecurity, rateLimit } from "./security.js";
import { assertUpstreamAuth } from "./upstream.js";
import { allTools } from "./tools/index.js";

assertConfigured();
// SHOP_DEMO_READ_ONLY and SHOP_DEMO_DISABLED_TOOLS decide which tools exist at all
const tools = enabledTools(allTools);

// Called once per stdio connection and once per HTTP request, so it must return a fresh server each time
function createServer(): McpServer {
  const server = new McpServer({ name: "shop-demo-mcp-server", version: "1.0.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args, ctx) => {
        const started = Date.now();
        const caller = ctx.http?.authInfo?.clientId ?? "local";
        try {
          const result = await callOperation(tool, args as Record<string, unknown>, ctx.mcpReq.signal, ctx.http?.authInfo);
          auditLog({ tool: tool.name, caller, ok: true, ms: Date.now() - started });
          return result;
        } catch (error) {
          auditLog({ tool: tool.name, caller, ok: false, ms: Date.now() - started });
          throw error;
        }
      }
    );
  }
  return server;
}

if (process.env.TRANSPORT === "http") {
  // Exits unless the bind is local-only or an authentication mode is configured (see SECURITY.md)
  const security = httpSecurity();
  assertUpstreamAuth(security.mode);
  const app = security.host === "127.0.0.1" ? createMcpExpressApp() : createMcpExpressApp({ host: security.host, allowedHosts: security.allowedHosts });
  for (const route of security.routes) app.get(route.path, route.handler);
  const nodeHandler = toNodeHandler(createMcpHandler(createServer));
  app.all("/mcp", ...security.middleware, rateLimit(), (req, res) => void nodeHandler(req, res, req.body));

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, security.host, () => console.error(`shop-demo-mcp-server listening on http://${security.host}:${port}/mcp (auth: ${security.mode})`));
} else {
  assertUpstreamAuth("stdio");
  serveStdio(createServer);
  console.error("shop-demo-mcp-server running on stdio (" + tools.length + " tools)"); // stderr: stdout carries the protocol
}
