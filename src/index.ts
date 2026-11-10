#!/usr/bin/env node
/**
 * connector-forge-mcp-server: helps any platform build an MCP connector for its own product.
 * Serves stdio by default, Streamable HTTP when TRANSPORT=http.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { generateProject, planTools } from "./codegen.js";
import { CHARACTER_LIMIT, RECOMMENDED_MAX_TOOLS, SERVER_NAME, SERVER_VERSION, SINGLE_FILE_LIMIT } from "./constants.js";
import { GUIDE_TOPICS, GUIDES } from "./guides.js";
import { lintTools } from "./lint.js";
import { servicePrefix } from "./naming.js";
import { loadSpec, selectOperations, type ParsedSpec } from "./spec.js";

const IS_HTTP = process.env.TRANSPORT === "http";
/** Where delivery="write" puts projects. Over HTTP it is off unless FORGE_OUTPUT_DIR is set. */
const OUTPUT_ROOT = process.env.FORGE_OUTPUT_DIR ?? (IS_HTTP ? undefined : path.resolve("connector-forge-output"));

// ---- Shared argument fields ----

const sourceFields = {
  spec: z.string().min(20).optional().describe("The OpenAPI document itself, as JSON or YAML text. Provide exactly one of spec, spec_url, spec_id"),
  spec_url: z.string().max(2000).optional().describe("Public https URL of the OpenAPI document, e.g. 'https://api.acme.com/openapi.json'"),
  spec_id: z.string().max(64).optional().describe("ID returned by an earlier forge_analyze_api call, to avoid sending the spec again"),
  graphql_schema: z
    .string()
    .min(20)
    .optional()
    .describe("For GraphQL APIs, instead of spec: the schema as SDL text or an introspection result (JSON). Needs graphql_endpoint"),
  graphql_endpoint: z.string().max(2000).optional().describe("With graphql_schema: the URL the API accepts queries at, e.g. 'https://api.acme.com/graphql'"),
  graphql_auth_header: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .max(60)
    .optional()
    .describe("With graphql_schema: header the API expects its access token in, e.g. 'X-API-Key'. Omit for 'Authorization: Bearer'")
};

const selectionFields = {
  include_tags: z.array(z.string()).max(50).optional().describe("Only operations with one of these OpenAPI tags, e.g. ['Invoices', 'Customers']"),
  include_operations: z
    .array(z.string())
    .max(200)
    .optional()
    .describe("Only these operations, by tool name or operationId from forge_analyze_api, e.g. ['list_invoices', 'get_invoice']"),
  read_only: z.boolean().default(false).describe("true keeps only GET operations: a safe first version of a connector"),
  include_deprecated: z.boolean().default(false).describe("true keeps operations the spec marks deprecated")
};

const responseFormat = z.enum(["markdown", "json"]).default("markdown").describe("'markdown' for readable text, 'json' for structured data");

const json = (data: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data });
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

function tagCounts(spec: ParsedSpec): string {
  const counts = new Map<string, number>();
  for (const op of spec.operations) for (const tag of op.tags.length > 0 ? op.tags : ["(untagged)"]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([tag, count]) => `${tag} (${count})`)
    .join(", ");
}

// ---- Server factory: called once per stdio connection and once per HTTP request ----

function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "forge_analyze_api",
    {
      title: "Analyze an API for a connector",
      description: `Read a product's OpenAPI spec (3.x or Swagger 2.0, JSON or YAML), or its GraphQL schema (graphql_schema plus graphql_endpoint), and report what an MCP connector for it would look like: base URL, authentication scheme, and each API operation with the tool name it would get.

Start here. Returns a spec_id to pass to forge_generate_connector, plus one page of operations; when more exist the result gives next_offset. Use the tag list in the result to narrow a large API.

Examples:
  - "Help me build an MCP connector for our API at https://api.acme.com/openapi.json" -> spec_url="https://api.acme.com/openapi.json", service_name="Acme"
  - "What read-only tools could we expose for billing?" -> spec_id=..., include_tags=["Billing"], read_only=true
  - "Our API is GraphQL" -> graphql_schema="type Query { ... }", graphql_endpoint="https://api.acme.com/graphql", service_name="Acme"
If the platform has neither an OpenAPI spec nor a GraphQL schema, call forge_get_guide with topic="no_openapi" instead.`,
      inputSchema: z.strictObject({
        ...sourceFields,
        service_name: z.string().min(1).max(40).optional().describe("Product name used as the tool prefix, e.g. 'Acme'. Defaults to the spec's title"),
        ...selectionFields,
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum number of operations to return"),
        offset: z.number().int().min(0).default(0).describe("Number of operations to skip, for pagination"),
        response_format: responseFormat
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, ctx) => {
      const spec = await loadSpec(args, ctx.mcpReq.signal);
      const prefix = servicePrefix(args.service_name ?? spec.title);
      const selected = selectOperations(spec, args);
      const planned = planTools(spec, selected, prefix);

      const render = (count: number) => {
        const tools = planned.slice(args.offset, args.offset + count).map(tool => ({
          tool_name: tool.name,
          title: tool.title,
          method: tool.method,
          path: tool.path,
          tag: tool.group,
          kind: tool.annotations.readOnlyHint ? "read" : tool.annotations.destructiveHint ? "write (destructive)" : "write",
          arguments: Object.keys(tool.inputSchema.properties as Record<string, unknown>)
        }));
        const nextOffset = args.offset + tools.length;
        const hasMore = planned.length > nextOffset;
        const page = {
          spec_id: spec.id,
          api: { title: spec.title, version: spec.version, base_url: spec.baseUrl },
          auth: spec.auth,
          tool_prefix: prefix,
          tags: tagCounts(spec),
          total_operations_in_spec: spec.operations.length,
          total: planned.length,
          count: tools.length,
          offset: args.offset,
          tools,
          has_more: hasMore,
          ...(hasMore ? { next_offset: nextOffset } : {}),
          warnings: spec.warnings.slice(0, 10)
        };
        if (args.response_format === "json") return { page, text: JSON.stringify(page, null, 2) };

        const lines = [
          `# ${spec.title} (v${spec.version})`,
          `- spec_id: ${spec.id}`,
          `- Base URL: ${spec.baseUrl}`,
          `- Auth: ${spec.auth.kind}${spec.auth.name ? ` (${spec.auth.name})` : ""}${spec.auth.note ? `. ${spec.auth.note}` : ""}`,
          `- Tool prefix: ${prefix}_`,
          `- Tags: ${page.tags}`,
          `- Matching operations: ${planned.length} of ${spec.operations.length} in the spec`,
          "",
          `## Proposed tools (${tools.length}, from offset ${args.offset})`,
          ...tools.map(tool => `- **${tool.tool_name}**: ${tool.method} ${tool.path} [${tool.kind}] ${tool.title}`)
        ];
        if (hasMore) lines.push("", `More operations: call again with offset=${nextOffset}.`);
        if (planned.length > RECOMMENDED_MAX_TOOLS) {
          lines.push("", `Note: ${planned.length} tools is a lot for one connector. Narrow with include_tags, include_operations, or read_only before generating (aim for ${RECOMMENDED_MAX_TOOLS} or fewer).`);
        }
        if (page.warnings.length > 0) lines.push("", "## Warnings", ...page.warnings.map(warning => `- ${warning}`));
        lines.push("", `Next: forge_generate_connector with spec_id="${spec.id}" and a service_name.`);
        return { page, text: lines.join("\n") };
      };

      // Stay under CHARACTER_LIMIT by returning fewer operations; next_offset then points at the first one left out
      let count = args.limit;
      let result = render(count);
      while (count > 1 && result.text.length > CHARACTER_LIMIT) {
        count = Math.ceil(count / 2);
        result = render(count);
      }
      if (planned.length === 0) {
        return text(`No operations match those filters. The spec has ${spec.operations.length} operations with tags: ${tagCounts(spec)}. spec_id: ${spec.id}`);
      }
      return args.response_format === "json" ? { content: [{ type: "text", text: result.text }], structuredContent: result.page } : text(result.text);
    }
  );

  server.registerTool(
    "forge_generate_connector",
    {
      title: "Generate an MCP connector project",
      description: `Generate a complete MCP connector for a product from its OpenAPI spec or GraphQL schema: a TypeScript project (MCP SDK v2) with one tool per selected API operation, typed argument schemas, error messages the model can act on, stdio and Streamable HTTP transports, a smoke test, a README, and a SECURITY.md. Security is built in: credentials only from environment variables, https-only API calls, HTTP mode that refuses to listen publicly without authentication (static token or OAuth with audience checks), rate limiting, an audit log, read-only / disabled-tool switches, and optional per-user API access by token exchange so one hosted connector can serve many accounts. A Dockerfile and a CI workflow are included. The project builds and runs as generated; SECURITY.md lists what the team must still review.

Returns JSON: the package name, environment variables, the tool list, a lint report, and the files.
  - delivery="inline" (default) returns file contents. If they do not fit in one response you get a manifest instead; call again with the same arguments plus paths=[...] to fetch files in batches. Output is deterministic, so batches are consistent.
  - delivery="write" saves the project to disk on the machine running this server and returns the folder.

Refuses more than max_tools operations; narrow with include_tags, include_operations, or read_only (forge_analyze_api lists the options).

Examples:
  - "Generate a read-only connector for Acme's invoices" -> spec_id=..., service_name="Acme", include_tags=["Invoices"], read_only=true
  - "Write the whole project to disk" -> spec_id=..., service_name="Acme", delivery="write"`,
      inputSchema: z.strictObject({
        ...sourceFields,
        service_name: z.string().min(1).max(40).describe("Product name, e.g. 'Acme'. Becomes the tool prefix (acme_) and the package name (acme-mcp-server)"),
        ...selectionFields,
        max_tools: z.number().int().min(1).max(150).default(RECOMMENDED_MAX_TOOLS).describe("Refuse to generate more tools than this"),
        delivery: z.enum(["inline", "write"]).default("inline").describe("'inline' returns file contents; 'write' saves the project to disk on the server machine"),
        paths: z.array(z.string()).max(50).optional().describe("With delivery='inline': return only these files, e.g. ['src/api.ts', 'src/index.ts']"),
        overwrite: z.boolean().default(false).describe("With delivery='write': allow writing into a folder that already has files")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (args, ctx) => {
      const spec = await loadSpec(args, ctx.mcpReq.signal);
      const selected = selectOperations(spec, args);
      if (selected.length === 0) { 
        throw new Error(`No operations match those filters. Available tags: ${tagCounts(spec)}. Call forge_analyze_api with spec_id="${spec.id}" to see operations.`);
      }
      if (selected.length > args.max_tools) {
        throw new Error(
          `${selected.length} operations match, more than max_tools=${args.max_tools}. Narrow with include_tags (available: ${tagCounts(spec)}), include_operations, or read_only=true; or raise max_tools (up to 150) if you really want them all.`
        );
      }

      const project = generateProject(spec, selected, args.service_name);
      const lint = lintTools(project.tools, project.prefix);
      const manifest = project.files.map(file => ({ path: file.path, characters: file.content.length }));
      const summary = {
        spec_id: spec.id,
        package_name: project.packageName,
        tool_prefix: `${project.prefix}_`,
        env_vars: project.envVars,
        tools: project.tools.map(tool => ({ name: tool.name, method: tool.method, path: tool.path })),
        lint: {
          score: lint.score,
          errors: lint.errors,
          warnings: lint.warnings,
          top_findings: lint.findings.filter(finding => finding.severity !== "info").slice(0, 8)
        },
        warnings: spec.warnings.slice(0, 10)
      };
      const nextSteps = "npm install && npm run build, set the environment variables, then npm run smoke. The project's README lists what to review before shipping.";

      if (args.delivery === "write") {
        if (!OUTPUT_ROOT) {
          throw new Error("Writing to disk is turned off on this server (it runs over HTTP without FORGE_OUTPUT_DIR). Use delivery='inline' instead.");
        }
        const target = path.join(OUTPUT_ROOT, project.packageName);
        const existing = await readdir(target).catch(() => [] as string[]);
        if (existing.length > 0 && !args.overwrite) {
          throw new Error(`${target} already has files. Pass overwrite=true to replace generated files there, or use a different service_name.`);
        }
        for (const file of project.files) {
          const destination = path.join(target, file.path);
          // Generated paths are built from sanitized names; this guards against a bug ever writing outside the target
          if (!destination.startsWith(target + path.sep)) throw new Error(`Refusing to write outside the project folder: ${file.path}`);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, file.content, "utf8");
        }
        return json({ ...summary, written_to: target, files: manifest, next_steps: `cd ${target} && ${nextSteps}` });
      }

      let files = project.files;
      if (args.paths) {
        files = project.files.filter(file => args.paths?.includes(file.path));
        const unknown = args.paths.filter(wanted => !project.files.some(file => file.path === wanted));
        if (unknown.length > 0) throw new Error(`Unknown path(s): ${unknown.join(", ")}. Available: ${manifest.map(file => file.path).join(", ")}`);
        const size = files.reduce((sum, file) => sum + file.content.length, 0);
        // One explicitly requested file is returned whole even when it is long
        if (size > CHARACTER_LIMIT && files.length > 1) {
          throw new Error(`Those ${files.length} files total ${size} characters, over the ${CHARACTER_LIMIT} limit per response. Request fewer files per call. Sizes: ${manifest.map(file => `${file.path} (${file.characters})`).join(", ")}`);
        }
        if (size > SINGLE_FILE_LIMIT) throw new Error(`${files[0].path} is ${size} characters. Generate fewer tools per connector, or use delivery='write'.`);
        return json({ package_name: project.packageName, files });
      }

      const full = { ...summary, files, next_steps: nextSteps };
      if (JSON.stringify(full, null, 2).length <= CHARACTER_LIMIT) return json(full);
      return json({
        ...summary,
        files_omitted: `The project is too large for one response. Call again with the same arguments plus paths=[...] to fetch files in batches under ${CHARACTER_LIMIT} characters${OUTPUT_ROOT ? ", or use delivery='write'" : ""}.`,
        manifest,
        next_steps: nextSteps
      });
    }
  );

  server.registerTool(
    "forge_lint_tools",
    {
      title: "Lint MCP tool definitions",
      description: `Check the tool definitions of any MCP connector, written in any language, against tool-design practices: naming and service prefix, descriptions, argument documentation, pagination on list tools, annotations that contradict the name, and tool count. Returns a 0-100 score and findings, each with a concrete fix.

Pass the tools exactly as the connector's tools/list returns them. Use this to review a hand-written or edited connector; forge_generate_connector already includes a lint report for what it generates.

Example: "Review our connector's tools" -> tools=[{name: "acme_list_orders", description: "...", inputSchema: {...}, annotations: {...}}]`,
      inputSchema: z.strictObject({
        tools: z
          .array(
            z.looseObject({
              name: z.string().min(1).max(200).describe("Tool name, e.g. 'acme_list_orders'"),
              title: z.string().optional().describe("Display title"),
              description: z.string().optional().describe("Tool description as the model sees it"),
              inputSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema of the tool's arguments"),
              annotations: z.record(z.string(), z.unknown()).optional().describe("Tool annotations, e.g. {readOnlyHint: true}")
            })
          )
          .min(1)
          .max(300)
          .describe("Tool definitions, as returned by tools/list"),
        service_prefix: z.string().max(30).optional().describe("Prefix every tool name should start with, e.g. 'acme'. Detected when omitted"),
        response_format: responseFormat
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ tools, service_prefix, response_format }) => {
      const report = lintTools(tools, service_prefix);

      const render = (count: number) => {
        const shown = report.findings.slice(0, count);
        const data = { ...report, findings: shown, findings_shown: shown.length, findings_total: report.findings.length };
        if (response_format === "json") return { data, text: JSON.stringify(data, null, 2) };
        const lines = [
          `# Lint report: ${report.score}/100`,
          `${report.tool_count} tools, ${report.errors} errors, ${report.warnings} warnings, ${report.infos} suggestions. Prefix: ${report.detected_prefix ?? "none detected"}.`,
          ""
        ];
        for (const finding of shown) lines.push(`- [${finding.severity}] ${finding.tool} (${finding.rule}): ${finding.message} Fix: ${finding.fix}`);
        if (shown.length < report.findings.length) lines.push("", `Showing the ${shown.length} most severe of ${report.findings.length} findings. Fix these and lint again.`);
        if (report.findings.length === 0) lines.push("No findings. Next: test with a model (forge_get_guide topic='testing').");
        return { data, text: lines.join("\n") };
      };

      let count = report.findings.length;
      let result = render(count);
      while (count > 1 && result.text.length > CHARACTER_LIMIT) {
        count = Math.ceil(count / 2);
        result = render(count);
      }
      return response_format === "json" ? { content: [{ type: "text", text: result.text }], structuredContent: result.data } : text(result.text);
    }
  );

  server.registerTool(
    "forge_get_guide",
    {
      title: "Get a connector-building guide",
      description: `Get a short practical guide for a team building an MCP connector for its own product. Topics: overview (the whole path, local vs hosted), tool_design (names, descriptions, responses, errors, annotations), auth (API keys and per-user OAuth), security (what the generated connector enforces and what to review), hosting (running a remote connector), testing (smoke tests, Inspector, model evaluations), no_openapi (what to do without an OpenAPI spec), launch_checklist.

Example: "How should we handle sign-in for a hosted connector?" -> topic="auth"`,
      inputSchema: z.strictObject({
        topic: z.enum(GUIDE_TOPICS).default("overview").describe("Which guide to return")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ topic }) => {
      const guide = GUIDES[topic];
      const others = GUIDE_TOPICS.filter(other => other !== topic).join(", ");
      return text(`# ${guide.title}\n\n${guide.body}\n\n---\nOther topics: ${others}`);
    }
  );

  server.registerPrompt(
    "forge_build_connector",
    {
      title: "Build a connector for my product",
      description: "Walk through analyzing an API, choosing tools, generating a connector, and reviewing it",
      argsSchema: z.object({
        product: z.string().describe("Product name, e.g. Acme"),
        spec_url: z.string().optional().describe("URL of the product's OpenAPI spec, if it has one")
      })
    },
    async ({ product, spec_url }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Help me build an MCP connector for ${product}.
${spec_url ? `Our OpenAPI spec is at ${spec_url}. Start with forge_analyze_api (service_name="${product}").` : "Ask me for our OpenAPI spec (URL or pasted text). If we have none, use forge_get_guide with topic=\"no_openapi\"."}
Then: (1) summarize the API and its auth, and ask what our users most need to do; (2) propose a first set of at most 25 tools, read-only unless I ask for writes; (3) run forge_generate_connector with that selection; (4) show the lint findings and suggest better descriptions for the five most important tools; (5) tell me how to build, test, and host it, using forge_get_guide where useful.`
          }
        }
      ]
    })
  );

  return server;
}

// ---- Transport selection ----

if (IS_HTTP) {
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (host !== "127.0.0.1" && allowedHosts.length === 0) {
    console.error("Set ALLOWED_HOSTS (comma-separated public hostnames) when HOST is not 127.0.0.1");
    process.exit(1);
  }
  // Fail closed: a public bind needs a bearer secret
  const secret = process.env.MCP_AUTH_TOKEN;
  if (host !== "127.0.0.1" && (!secret || secret.length < 32)) {
    console.error("Set MCP_AUTH_TOKEN (32+ characters, e.g. from `openssl rand -hex 32`) when HOST is not 127.0.0.1");
    process.exit(1);
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const app = host === "127.0.0.1" ? createMcpExpressApp() : createMcpExpressApp({ host, allowedHosts });
  const nodeHandler = toNodeHandler(createMcpHandler(createServer));
  app.all("/mcp", (req, res) => {
    if (secret) {
      const header = req.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (presented === "" || !timingSafeEqual(digest(presented), digest(secret))) {
        res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "invalid_token" });
        return;
      }
    }
    void nodeHandler(req, res, req.body);
  });

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, host, () => console.error(`${SERVER_NAME} listening on http://${host}:${port}/mcp`));
} else {
  serveStdio(createServer);
  console.error(`${SERVER_NAME} running on stdio`);
}
