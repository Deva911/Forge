/**
 * Generates a complete, runnable MCP connector project (TypeScript, MCP SDK v2)
 * from a parsed OpenAPI spec. Output is deterministic: the same inputs always
 * produce the same files, so callers can fetch files across several calls.
 */
import { servicePrefix, snakeCase, titleCase, uniqueName } from "./naming.js";
import { annotationsFor, type AuthScheme, type JsonSchema, type Operation, type ParsedSpec } from "./spec.js";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface PlannedTool {
  name: string;
  title: string;
  description: string;
  method: string;
  path: string;
  group: string;
  annotations: ReturnType<typeof annotationsFor>;
  inputSchema: JsonSchema;
}

export interface GeneratedProject {
  packageName: string;
  prefix: string;
  envVars: { name: string; required: boolean; purpose: string }[];
  tools: PlannedTool[];
  files: GeneratedFile[];
}

const lit = (value: unknown): string => JSON.stringify(value);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// ---- JSON Schema -> Zod source ----

function mergeAllOf(schema: JsonSchema): JsonSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const merged: JsonSchema = { ...schema, type: "object" };
  delete merged.allOf;
  const properties: Record<string, unknown> = isObject(schema.properties) ? { ...schema.properties } : {};
  const required = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const part of schema.allOf) {
    if (!isObject(part)) continue;
    const flat = mergeAllOf(part);
    if (isObject(flat.properties)) Object.assign(properties, flat.properties);
    if (Array.isArray(flat.required)) for (const name of flat.required as string[]) required.add(name);
    if (!merged.description && typeof flat.description === "string") merged.description = flat.description;
  }
  merged.properties = properties;
  merged.required = [...required];
  return merged;
}

function describeSuffix(schema: JsonSchema, extra?: string): string {
  const parts: string[] = [];
  const description = extra ?? (typeof schema.description === "string" ? schema.description : undefined);
  if (description) {
    const clipped = clip(description, 300);
    parts.push(/[.!?…]$/.test(clipped) ? clipped : `${clipped}.`);
  }
  if (typeof schema.format === "string" && !/^(int32|int64|float|double)$/.test(schema.format)) parts.push(`Format: ${schema.format}.`);
  if (schema.default !== undefined && typeof schema.default !== "object") parts.push(`API default: ${String(schema.default)}.`);
  if (schema.example !== undefined && typeof schema.example !== "object") parts.push(`Example: ${String(schema.example)}.`);
  return parts.length > 0 ? `.describe(${lit(parts.join(" "))})` : "";
}

/** Returns Zod source code for a JSON Schema. Unknown or very deep shapes become z.unknown(). */
export function zodSource(input: JsonSchema | undefined, depth = 0, description?: string): string {
  if (!input || depth > 6) return `z.unknown()${description ? `.describe(${lit(clip(description, 300))})` : ""}`;
  const schema = mergeAllOf(input);
  let types = Array.isArray(schema.type) ? (schema.type as string[]) : typeof schema.type === "string" ? [schema.type] : [];
  const nullable = schema.nullable === true || types.includes("null");
  types = types.filter(type => type !== "null");
  let type = types[0];
  if (!type && isObject(schema.properties)) type = "object";

  let code: string;
  const variants = (schema.oneOf ?? schema.anyOf) as unknown;
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(value => typeof value === "string")) {
    code = `z.enum(${lit(schema.enum)})`;
  } else if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(value => ["string", "number", "boolean"].includes(typeof value))) {
    const literals = schema.enum.map(value => `z.literal(${lit(value)})`);
    code = literals.length === 1 ? literals[0] : `z.union([${literals.join(", ")}])`;
  } else if (Array.isArray(variants) && variants.length > 0) {
    const options = [...new Set(variants.filter(isObject).map(variant => zodSource(variant, depth + 1)))];
    code = options.length === 0 ? "z.unknown()" : options.length === 1 ? options[0] : `z.union([${options.join(", ")}])`;
  } else if (type === "string") {
    code = "z.string()";
    if (typeof schema.minLength === "number" && schema.minLength > 0) code += `.min(${schema.minLength})`;
    if (typeof schema.maxLength === "number") code += `.max(${schema.maxLength})`;
  } else if (type === "integer" || type === "number") {
    code = type === "integer" ? "z.number().int()" : "z.number()";
    if (typeof schema.minimum === "number") code += `.min(${schema.minimum})`;
    if (typeof schema.maximum === "number") code += `.max(${schema.maximum})`;
  } else if (type === "boolean") {
    code = "z.boolean()";
  } else if (type === "array") {
    code = `z.array(${zodSource(isObject(schema.items) ? schema.items : undefined, depth + 1)})`;
  } else if (type === "object") {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const names = Object.keys(properties);
    if (names.length === 0) {
      code = "z.record(z.string(), z.unknown())";
    } else {
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const fields = names
        .filter(name => !(isObject(properties[name]) && (properties[name] as JsonSchema).readOnly === true))
        .map(name => {
          const field = zodSource(isObject(properties[name]) ? (properties[name] as JsonSchema) : undefined, depth + 1);
          return `${lit(name)}: ${field}${required.has(name) ? "" : ".optional()"}`;
        });
      // Loose: fields the spec does not list still reach the API
      code = `z.looseObject({ ${fields.join(", ")} })`;
    }
  } else {
    code = "z.unknown()";
  }

  if (nullable) code += ".nullable()";
  return code + describeSuffix(schema, description);
}

/** JSON Schema of a tool's arguments, used for the plan and the linter. */
function inputJsonSchema(op: Operation): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of op.params) {
    properties[param.arg] = { ...param.schema, ...(param.description ? { description: param.description } : {}) };
    if (param.required) required.push(param.arg);
  }
  if (op.body) {
    properties.body = { ...op.body.schema, description: (op.body.schema.description as string | undefined) ?? "Request body" };
    if (op.body.required) required.push("body");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function toolDescription(op: Operation, serviceTitle: string): string {
  const lines: string[] = [];
  const summary = op.summary ?? titleCase(op.baseToolName);
  lines.push(clip(summary.endsWith(".") ? summary : `${summary}.`, 200));
  if (op.description && clip(op.description, 200) !== clip(summary, 200)) lines.push(clip(op.description, 600));
  lines.push(
    op.graphql
      ? `Runs the GraphQL ${op.graphql.kind} '${op.path}' on ${serviceTitle} and returns the JSON response.`
      : `Calls ${op.method} ${op.path} on ${serviceTitle} and returns the JSON response.`
  );
  if (op.method === "DELETE" || op.graphql?.destructive) lines.push("This removes data and may not be reversible; confirm with the user first.");
  return lines.join("\n\n");
}

function groupName(tag: string | undefined): string {
  const name = snakeCase(tag ?? "") || "general";
  return /^[a-z]/.test(name) ? name.slice(0, 40) : `group_${name}`.slice(0, 40);
}

export function planTools(spec: ParsedSpec, operations: Operation[], prefix: string): PlannedTool[] {
  const used = new Set<string>();
  return operations.map(op => ({
    name: uniqueName(`${prefix}_${op.baseToolName}`.slice(0, 64).replace(/_+$/, ""), used),
    title: clip(op.title, 80),
    description: toolDescription(op, spec.title),
    method: op.method,
    path: op.path,
    group: groupName(op.tags[0]),
    annotations: annotationsFor(op),
    inputSchema: inputJsonSchema(op)
  }));
}

// ---- File templates ----

function authPlan(auth: AuthScheme, envPrefix: string): { envVars: GeneratedProject["envVars"]; code: string } {
  switch (auth.kind) {
    case "bearer":
      return {
        envVars: [{ name: `${envPrefix}_API_TOKEN`, required: true, purpose: "Access token sent as `Authorization: Bearer <token>`" }],
        code: `const TOKEN = process.env.${envPrefix}_API_TOKEN;
const REQUIRED_ENV = ["${envPrefix}_API_TOKEN"];

function applyAuth(headers: Record<string, string>, _url: URL): void {
  headers.Authorization = \`Bearer \${TOKEN}\`;
}`
      };
    case "basic":
      return {
        envVars: [
          { name: `${envPrefix}_USERNAME`, required: true, purpose: "HTTP Basic username" },
          { name: `${envPrefix}_PASSWORD`, required: true, purpose: "HTTP Basic password" }
        ],
        code: `const USERNAME = process.env.${envPrefix}_USERNAME;
const PASSWORD = process.env.${envPrefix}_PASSWORD;
const REQUIRED_ENV = ["${envPrefix}_USERNAME", "${envPrefix}_PASSWORD"];

function applyAuth(headers: Record<string, string>, _url: URL): void {
  headers.Authorization = \`Basic \${Buffer.from(\`\${USERNAME}:\${PASSWORD}\`).toString("base64")}\`;
}`
      };
    case "apiKeyHeader":
      return {
        envVars: [{ name: `${envPrefix}_API_KEY`, required: true, purpose: `API key sent in the \`${auth.name}\` header` }],
        code: `const API_KEY = process.env.${envPrefix}_API_KEY;
const REQUIRED_ENV = ["${envPrefix}_API_KEY"];

function applyAuth(headers: Record<string, string>, _url: URL): void {
  headers[${lit(auth.name)}] = API_KEY as string;
}`
      };
    case "apiKeyQuery":
      return {
        envVars: [{ name: `${envPrefix}_API_KEY`, required: true, purpose: `API key sent as the \`${auth.name}\` query parameter` }],
        code: `const API_KEY = process.env.${envPrefix}_API_KEY;
const REQUIRED_ENV = ["${envPrefix}_API_KEY"];

function applyAuth(_headers: Record<string, string>, url: URL): void {
  url.searchParams.set(${lit(auth.name)}, API_KEY as string);
}`
      };
    default:
      return {
        envVars: [],
        code: `const REQUIRED_ENV: string[] = [];

// The spec declares no authentication. Add credentials here if the API needs them.
function applyAuth(_headers: Record<string, string>, _url: URL): void {}`
      };
  }
}

function apiFile(spec: ParsedSpec, envPrefix: string, authCode: string, firstListTool: string | undefined): string {
  const label = spec.title.replace(/\s+API$/i, "") || spec.title;
  return `/**
 * ${spec.title} API client: one request helper that every tool calls.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { UPSTREAM_AUTH, userCredential } from "./upstream.js";

export const API_BASE_URL = (process.env.${envPrefix}_BASE_URL ?? ${lit(spec.baseUrl)}).replace(/\\/+$/, "");
export const API_LABEL = ${lit(label)};
/** Tool responses stay under this many characters so they do not flood the model's context */
export const CHARACTER_LIMIT = 25_000;
const TIMEOUT_MS = 30_000;

${authCode}

/** Exits with a clear message when configuration is missing or unsafe. */
export function assertConfigured(): void {
  // With per-user credentials there is no shared credential to require
  const missing = UPSTREAM_AUTH === "shared" ? REQUIRED_ENV.filter(name => !process.env[name]) : [];
  if (missing.length > 0) {
    console.error(\`Missing required environment variable(s): \${missing.join(", ")}\`);
    process.exit(1);
  }
  // Credentials must never travel over plain http, except to a local test server
  const base = new URL(API_BASE_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !local) {
    console.error(\`${envPrefix}_BASE_URL must use https (got \${base.protocol}//\${base.hostname}).\`);
    process.exit(1);
  }
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  method: string;
  path: string;
  /** Maps tool arguments to API parameters */
  params: { arg: string; name: string; in: "path" | "query" | "header" }[];
  /** Content type of the request body, when the operation takes one */
  bodyType?: string;
  /** For GraphQL APIs: the query text this tool sends. Edit the selected fields to change what it returns */
  graphql?: string;
  inputSchema: z.ZodObject;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

// Thrown errors reach the model as the tool result's text, so say how to recover
function httpErrorMessage(status: number, detail: string): string {
  const suffix = detail ? \` API said: \${detail}\` : "";
  switch (status) {
    case 400:
    case 422:
      return \`The ${label} API rejected the request (HTTP \${status}). Check the argument values.\${suffix}\`;
    case 401:
      return \`Authentication failed (HTTP 401). The connector's credentials are missing, invalid, or expired.\${suffix}\`;
    case 403:
      return \`Permission denied (HTTP 403): these credentials cannot do that.\${suffix}\`;
    case 404:
      return \`Not found (HTTP 404). Check the IDs in the request${firstListTool ? `; ${firstListTool} returns valid ones` : ""}.\${suffix}\`;
    case 429:
      return \`Rate limit exceeded (HTTP 429). Wait a minute before making more requests.\${suffix}\`;
    default:
      return status >= 500
        ? \`The ${label} API had a server error (HTTP \${status}). Try again shortly.\${suffix}\`
        : \`The ${label} API returned HTTP \${status}.\${suffix}\`;
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(httpErrorMessage(status, detail));
  }
}

class GraphQLFailure extends Error {
  constructor(detail: string) {
    super(\`The ${label} API rejected the request: \${detail}. Check the argument values.\`);
  }
}

function appendQuery(url: URL, name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) url.searchParams.append(name, String(item));
  } else if (typeof value === "object") {
    url.searchParams.set(name, JSON.stringify(value));
  } else {
    url.searchParams.set(name, String(value));
  }
}

/**
 * Keeps a response under CHARACTER_LIMIT. Lists are shortened by returning fewer
 * items (so the JSON stays valid); anything else is cut with a note.
 */
export function fitToLimit(data: unknown): string {
  const full = JSON.stringify(data, null, 2);
  if (full.length <= CHARACTER_LIMIT) return full;

  const record = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  const listKey = record ? Object.keys(record).find(key => Array.isArray(record[key]) && (record[key] as unknown[]).length > 1) : undefined;
  const list = Array.isArray(data) ? data : listKey && record ? (record[listKey] as unknown[]) : undefined;

  if (list && list.length > 1) {
    let items = list;
    let text = full;
    while (items.length > 1 && text.length > CHARACTER_LIMIT) {
      items = items.slice(0, Math.ceil(items.length / 2));
      const truncated = {
        returned: items.length,
        in_response: list.length,
        hint: "Response shortened to fit. Ask for a smaller page or add filters to see the rest."
      };
      text = JSON.stringify(Array.isArray(data) ? { items, truncated } : { ...record, [listKey as string]: items, truncated }, null, 2);
    }
    if (text.length <= CHARACTER_LIMIT) return text;
  }
  return \`\${full.slice(0, CHARACTER_LIMIT)}\\n\\n[Response cut at \${CHARACTER_LIMIT} of \${full.length} characters. Narrow the request with filters or a smaller page size.]\`;
}

/** Runs one API operation with the tool's arguments and returns an MCP tool result. */
export async function callOperation(tool: ToolDef, args: Record<string, unknown>, signal: AbortSignal, authInfo?: AuthInfo) {
  let path = tool.graphql ? "" : tool.path;
  const headers: Record<string, string> = { Accept: "application/json" };
  const query: [string, unknown][] = [];

  for (const param of tool.params) {
    const value = args[param.arg];
    if (param.in === "path") {
      const segment = String(value);
      // "." and ".." would be resolved by the URL parser and reach a different endpoint
      if (segment === "" || segment === "." || segment === "..") throw new Error(\`'\${segment}' is not a valid value for \${param.arg}.\`);
      path = path.replace(\`{\${param.name}}\`, encodeURIComponent(segment));
    }
    else if (param.in === "query") query.push([param.name, value]);
    else if (value !== undefined && value !== null) headers[param.name] = String(value);
  }

  const url = new URL(API_BASE_URL + path);
  if (!tool.graphql) for (const [name, value] of query) appendQuery(url, name, value);
  if (UPSTREAM_AUTH === "shared") applyAuth(headers, url);
  // Per-user mode: call the API as the signed-in user, never with a shared credential
  else headers.Authorization = \`Bearer \${await userCredential(authInfo, signal)}\`;

  let body: string | undefined;
  if (tool.graphql) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ query: tool.graphql, variables: Object.fromEntries(query.filter(([, value]) => value !== undefined)) });
  } else if (tool.bodyType && args.body !== undefined) {
    headers["Content-Type"] = tool.bodyType;
    body = tool.bodyType.includes("x-www-form-urlencoded")
      ? new URLSearchParams(Object.entries(args.body as Record<string, unknown>).map(([key, value]): [string, string] => [key, String(value)])).toString()
      : JSON.stringify(args.body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: tool.graphql ? "POST" : tool.method,
      headers,
      body,
      // Never follow redirects: they could send credentials to another host
      redirect: "error",
      // Aborts when the client cancels the call, or after the timeout
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(\`The ${label} API did not respond within \${TIMEOUT_MS / 1000} seconds. Try again, or narrow the request.\`);
    }
    throw new Error(\`Could not reach the ${label} API at \${API_BASE_URL}. Check the network and ${envPrefix}_BASE_URL.\`);
  }

  const raw = await response.text();
  if (!response.ok) throw new ApiError(response.status, raw.replace(/\\s+/g, " ").slice(0, 500));
  if (raw.trim() === "") return { content: [{ type: "text" as const, text: \`Done (HTTP \${response.status}, empty response).\` }] };

  let text: string;
  try {
    let data: unknown = JSON.parse(raw);
    if (tool.graphql) {
      // GraphQL reports failures in the body with HTTP 200
      const result = data as { data?: unknown; errors?: { message?: string }[] };
      if (result.errors?.length) {
        throw new GraphQLFailure(result.errors.map(error => error.message ?? "unknown error").join("; ").slice(0, 800));
      }
      data = result.data;
    }
    text = fitToLimit(data);
  } catch (error) {
    if (error instanceof GraphQLFailure) throw error;
    text = raw.length > CHARACTER_LIMIT ? \`\${raw.slice(0, CHARACTER_LIMIT)}\\n\\n[Response cut at \${CHARACTER_LIMIT} characters.]\` : raw;
  }
  return { content: [{ type: "text" as const, text }] };
}
`;
}

function toolEntry(op: Operation, tool: PlannedTool): string {
  const fields: string[] = [];
  for (const param of op.params) {
    const where = param.in === "path" ? "" : param.in === "query" ? "" : " (sent as a header)";
    const description = `${param.description ?? titleCase(param.arg)}${where}`;
    fields.push(`      ${lit(param.arg)}: ${zodSource(param.schema, 1, description)}${param.required ? "" : ".optional()"}`);
  }
  if (op.body) {
    const description = typeof op.body.schema.description === "string" ? op.body.schema.description : "Request body";
    fields.push(`      body: ${zodSource(op.body.schema, 1, description)}${op.body.required ? "" : ".optional()"}`);
  }
  const params = op.params.map(param => `{ arg: ${lit(param.arg)}, name: ${lit(param.name)}, in: ${lit(param.in)} }`).join(", ");
  const a = tool.annotations;
  return `  {
    name: ${lit(tool.name)},
    title: ${lit(tool.title)},
    description: ${lit(tool.description)},
    method: ${lit(op.method)},
    path: ${lit(op.path)},
    params: [${params}],${op.graphql ? `\n    graphql: ${lit(op.graphql.document)},` : ""}${op.body ? `\n    bodyType: ${lit(op.body.contentType)},` : ""}
    inputSchema: z.strictObject({${fields.length > 0 ? `\n${fields.join(",\n")}\n    ` : ""}}),
    annotations: { readOnlyHint: ${a.readOnlyHint}, destructiveHint: ${a.destructiveHint}, idempotentHint: ${a.idempotentHint}, openWorldHint: ${a.openWorldHint} }
  }`;
}

function camel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function indexFile(packageName: string, spec: ParsedSpec, envPrefix: string): string {
  return `#!/usr/bin/env node
/**
 * MCP server for ${spec.title}.
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
// ${envPrefix}_READ_ONLY and ${envPrefix}_DISABLED_TOOLS decide which tools exist at all
const tools = enabledTools(allTools);

// Called once per stdio connection and once per HTTP request, so it must return a fresh server each time
function createServer(): McpServer {
  const server = new McpServer({ name: ${lit(packageName)}, version: "1.0.0" });
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
  app.listen(port, security.host, () => console.error(\`${packageName} listening on http://\${security.host}:\${port}/mcp (auth: \${security.mode})\`));
} else {
  assertUpstreamAuth("stdio");
  serveStdio(createServer);
  console.error("${packageName} running on stdio (" + tools.length + " tools)"); // stderr: stdout carries the protocol
}
`;
}

function securityFile(envPrefix: string): string {
  return `/**
 * Safety and security controls for the connector. Everything here is configured
 * by environment variables; SECURITY.md explains each one.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getOAuthProtectedResourceMetadataUrl, requireBearerAuth, type OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ToolDef } from "./api.js";

// ---- Which tools exist ----

/** Applies ${envPrefix}_READ_ONLY=1 (drop every write tool) and ${envPrefix}_DISABLED_TOOLS=name,name. */
export function enabledTools(all: ToolDef[]): ToolDef[] {
  const readOnly = process.env.${envPrefix}_READ_ONLY === "1";
  const disabled = new Set((process.env.${envPrefix}_DISABLED_TOOLS ?? "").split(",").map(name => name.trim()).filter(Boolean));
  const unknown = [...disabled].filter(name => !all.some(tool => tool.name === name));
  if (unknown.length > 0) {
    // A typo here would silently leave a tool enabled, so refuse to start
    console.error(\`${envPrefix}_DISABLED_TOOLS names unknown tool(s): \${unknown.join(", ")}\`);
    process.exit(1);
  }
  return all.filter(tool => !disabled.has(tool.name) && (!readOnly || tool.annotations.readOnlyHint));
}

// ---- Audit log ----

/** One JSON line per tool call on stderr. Arguments and responses are never logged: they may hold user data. */
export function auditLog(entry: { tool: string; caller: string; ok: boolean; ms: number }): void {
  console.error(JSON.stringify({ time: new Date().toISOString(), event: "tool_call", ...entry }));
}

// ---- HTTP authentication ----

export interface HttpSecurity {
  mode: "oauth" | "static-token" | "none (localhost only)";
  host: string;
  allowedHosts: string[];
  middleware: RequestHandler[];
  routes: { path: string; handler: RequestHandler }[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Chooses how /mcp is protected:
 *  - OAuth (multi-user): set OAUTH_ISSUER, OAUTH_JWKS_URL, and MCP_SERVER_URL. Access tokens are JWTs
 *    verified for signature, issuer, expiry, and audience (the audience must be MCP_SERVER_URL).
 *  - Static token (single tenant): set MCP_AUTH_TOKEN to a random secret of 32+ characters.
 *  - Neither: only allowed while listening on 127.0.0.1.
 */
export function httpSecurity(): HttpSecurity {
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (host !== "127.0.0.1" && allowedHosts.length === 0) fail("Set ALLOWED_HOSTS (your public hostname) when HOST is not 127.0.0.1.");

  const issuer = process.env.OAUTH_ISSUER;
  const staticToken = process.env.MCP_AUTH_TOKEN;

  if (issuer) {
    const jwksUrl = process.env.OAUTH_JWKS_URL;
    const serverUrlRaw = process.env.MCP_SERVER_URL;
    if (!jwksUrl || !serverUrlRaw) fail("OAuth needs OAUTH_JWKS_URL and MCP_SERVER_URL (the public URL of this server's /mcp endpoint).");
    const serverUrl = new URL(serverUrlRaw);
    const jwks = createRemoteJWKSet(new URL(jwksUrl));
    const requiredScopes = (process.env.OAUTH_REQUIRED_SCOPES ?? "").split(/[ ,]+/).filter(Boolean);

    const verifier: OAuthTokenVerifier = {
      async verifyAccessToken(token): Promise<AuthInfo> {
        try {
          // The audience check means a token issued for some other service is refused here
          const { payload } = await jwtVerify(token, jwks, { issuer, audience: serverUrl.href.replace(/\\/$/, "") });
          if (typeof payload.exp !== "number") throw new Error("no expiry");
          const scope = typeof payload.scope === "string" ? payload.scope.split(" ") : Array.isArray(payload.scp) ? (payload.scp as string[]) : [];
          return {
            token,
            clientId: String(payload.client_id ?? payload.azp ?? payload.sub ?? "unknown"),
            scopes: scope,
            expiresAt: payload.exp,
            resource: serverUrl,
            extra: { sub: payload.sub }
          };
        } catch {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
        }
      }
    };

    const metadata = {
      resource: serverUrl.href.replace(/\\/$/, ""),
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      ...(requiredScopes.length > 0 ? { scopes_supported: requiredScopes } : {})
    };
    const metadataUrl = getOAuthProtectedResourceMetadataUrl(serverUrl);
    return {
      mode: "oauth",
      host,
      allowedHosts,
      middleware: [requireBearerAuth({ verifier, requiredScopes, expectedResource: serverUrl, resourceMetadataUrl: metadataUrl })],
      // Lets MCP clients discover where users sign in
      routes: [{ path: new URL(metadataUrl).pathname, handler: (_req, res) => void res.json(metadata) }]
    };
  }

  if (staticToken) {
    if (staticToken.length < 32) fail("MCP_AUTH_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32");
    const expected = sha256(staticToken);
    const check: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      // Hash both sides so the comparison is constant-time and length-independent
      if (presented === "" || !timingSafeEqual(sha256(presented), expected)) {
        res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "invalid_token", error_description: "Missing or invalid bearer token" });
        return;
      }
      next();
    };
    return { mode: "static-token", host, allowedHosts, middleware: [check], routes: [] };
  }

  if (host !== "127.0.0.1") {
    fail("Refusing to listen on a public interface without authentication. Configure OAuth (OAUTH_ISSUER, OAUTH_JWKS_URL, MCP_SERVER_URL) or MCP_AUTH_TOKEN. See SECURITY.md.");
  }
  return { mode: "none (localhost only)", host, allowedHosts, middleware: [], routes: [] };
}

// ---- Rate limiting ----

/**
 * Fixed-window limit per caller (token, else IP): RATE_LIMIT_PER_MINUTE, default 120, 0 to turn off.
 * In-memory, so each server instance counts separately; use your gateway's limiter when running several.
 */
export function rateLimit(): RequestHandler {
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120);
  const windows = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (!(limit > 0)) return next();
    const now = Date.now();
    const key = req.headers.authorization ? sha256(req.headers.authorization).toString("hex") : (req.ip ?? "unknown");
    let window = windows.get(key);
    if (!window || now - window.start >= 60_000) {
      window = { start: now, count: 0 };
      windows.set(key, window);
      if (windows.size > 10_000) for (const [other, entry] of windows) if (now - entry.start >= 60_000) windows.delete(other);
    }
    window.count += 1;
    if (window.count > limit) {
      res.status(429).set("Retry-After", String(Math.ceil((window.start + 60_000 - now) / 1000))).json({ error: "rate_limited", error_description: "Too many requests. Retry after the time in the Retry-After header." });
      return;
    }
    next();
  };
}
`;
}

function upstreamFile(envPrefix: string, spec: ParsedSpec): string {
  return `/**
 * Whose permissions API calls use.
 *
 *  ${envPrefix}_UPSTREAM_AUTH=shared (default): every call uses the one credential in the environment.
 *    Right for local use and for a deployment that serves a single account.
 *  ${envPrefix}_UPSTREAM_AUTH=token_exchange: each call uses a credential for the signed-in user, obtained from
 *    your authorization server by OAuth token exchange (RFC 8693). Right for one hosted connector that
 *    serves many accounts: nobody can reach data their own account cannot.
 */
import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";

export const UPSTREAM_AUTH: "shared" | "token_exchange" = process.env.${envPrefix}_UPSTREAM_AUTH === "token_exchange" ? "token_exchange" : "shared";

const TOKEN_ENDPOINT = process.env.OAUTH_TOKEN_ENDPOINT;
const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
/** The audience the exchanged token is for: your API */
const AUDIENCE = process.env.${envPrefix}_UPSTREAM_AUDIENCE ?? ${lit(spec.baseUrl)};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Exits when the combination of sign-in mode and credential mode would be unsafe or cannot work. */
export function assertUpstreamAuth(mode: string): void {
  const raw = process.env.${envPrefix}_UPSTREAM_AUTH;
  if (raw && raw !== "shared" && raw !== "token_exchange") fail("${envPrefix}_UPSTREAM_AUTH must be 'shared' or 'token_exchange'.");

  if (UPSTREAM_AUTH === "token_exchange") {
    if (mode !== "oauth") fail("${envPrefix}_UPSTREAM_AUTH=token_exchange needs OAuth sign-in over HTTP (TRANSPORT=http with OAUTH_ISSUER, OAUTH_JWKS_URL, MCP_SERVER_URL).");
    if (!TOKEN_ENDPOINT || !CLIENT_ID || !CLIENT_SECRET) fail("Token exchange needs OAUTH_TOKEN_ENDPOINT, OAUTH_CLIENT_ID, and OAUTH_CLIENT_SECRET.");
    const endpoint = new URL(TOKEN_ENDPOINT);
    if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname)) fail("OAUTH_TOKEN_ENDPOINT must use https.");
    return;
  }
  // Many users signing in while every call uses one credential means every user gets that credential's access.
  if (mode === "oauth" && process.env.${envPrefix}_ALLOW_SHARED_CREDENTIAL !== "1") {
    fail(
      "Refusing to start: OAuth sign-in is on, but API calls would all use one shared credential, so every user would get its access. " +
        "Set ${envPrefix}_UPSTREAM_AUTH=token_exchange for per-user access, or ${envPrefix}_ALLOW_SHARED_CREDENTIAL=1 if all users really should share it. See SECURITY.md."
    );
  }
}

const cache = new Map<string, { token: string; expiresAt: number }>();

/** Returns an API credential for the signed-in user, exchanging their connector token for one the API accepts. */
export async function userCredential(authInfo: AuthInfo | undefined, signal: AbortSignal): Promise<string> {
  if (!authInfo) throw new Error("Not signed in. Reconnect the connector and sign in again.");
  const key = createHash("sha256").update(authInfo.token).digest("hex");
  const now = Date.now() / 1000;
  const cached = cache.get(key);
  if (cached && cached.expiresAt - 30 > now) return cached.token;

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT as string, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: \`Basic \${Buffer.from(\`\${CLIENT_ID}:\${CLIENT_SECRET}\`).toString("base64")}\`
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: authInfo.token,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience: AUDIENCE
      }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    });
  } catch {
    throw new Error("Could not reach the sign-in service to authorize this request. Try again shortly.");
  }
  if (!response.ok) throw new Error("Your sign-in does not allow this request, or it has expired. Reconnect the connector and sign in again.");

  const result = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!result.access_token) throw new Error("The sign-in service returned no access token.");
  // Never keep a credential past the life of the sign-in it came from
  const expiresAt = Math.min(now + (result.expires_in ?? 300), authInfo.expiresAt ?? now + 300);
  cache.set(key, { token: result.access_token, expiresAt });
  if (cache.size > 5000) for (const [other, entry] of cache) if (entry.expiresAt <= now) cache.delete(other);
  return result.access_token;
}
`;
}

const DOCKERFILE = `FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TRANSPORT=http HOST=0.0.0.0 PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Run as the unprivileged user the base image provides
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
`;

const CI_WORKFLOW = `name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --no-fund
      - run: npm run build
      # Fails the build when a dependency has a known high-severity vulnerability
      - run: npm audit --omit=dev --audit-level=high
`;

function securityDoc(packageName: string, spec: ParsedSpec, envPrefix: string, tools: PlannedTool[]): string {
  const writes = tools.filter(tool => !tool.annotations.readOnlyHint);
  return `# Security of ${packageName}

What this connector enforces as generated, what you configure, and what still needs your review. A generator cannot certify a deployment: treat this as the starting point for your own security review.

## Built in

| Control | How it works |
|---|---|
| No secrets in code | API credentials come only from environment variables; the server exits if one is missing. They are never logged or returned in tool results. |
| HTTPS upstream only | The server exits if \`${envPrefix}_BASE_URL\` is not https (localhost excepted, for tests). |
| No redirects | API calls never follow redirects, so credentials cannot be sent to another host. |
| Strict inputs | Every tool validates its arguments against a schema and rejects unknown ones before any request is made. Path values are URL-encoded; \`.\` and \`..\` are refused. |
| Fail-closed HTTP | The server refuses to listen on a public interface unless OAuth or a static token is configured. |
| Token audience check | In OAuth mode, tokens are verified for signature, issuer, expiry, and audience; a token issued for another service is refused. |
| DNS-rebinding protection | Host and Origin headers are validated (\`ALLOWED_HOSTS\`). |
| Rate limit | \`RATE_LIMIT_PER_MINUTE\` per caller (default 120). |
| Timeouts and size caps | 30-second upstream timeout; responses capped at 25,000 characters. |
| Audit trail | One JSON line per tool call on stderr: tool, caller, success, duration. No arguments or response data. |
| Confirmation hints | Write tools are annotated so MCP clients can ask the user first; destructive ones are marked. |

## You configure

| Variable | Effect |
|---|---|
| \`${envPrefix}_READ_ONLY=1\` | Removes all ${writes.length} write tool(s). Recommended for a first launch. |
| \`${envPrefix}_DISABLED_TOOLS=a,b\` | Removes specific tools. Unknown names stop the server from starting. |
| \`MCP_AUTH_TOKEN\` | Single-tenant HTTP: one shared secret (32+ characters) required as a bearer token. |
| \`OAUTH_ISSUER\`, \`OAUTH_JWKS_URL\`, \`MCP_SERVER_URL\`, \`OAUTH_REQUIRED_SCOPES\` | Multi-user HTTP: per-user sign-in through your authorization server. |
| \`${envPrefix}_UPSTREAM_AUTH\`, \`${envPrefix}_UPSTREAM_AUDIENCE\`, \`OAUTH_TOKEN_ENDPOINT\`, \`OAUTH_CLIENT_ID\`, \`OAUTH_CLIENT_SECRET\` | Per-user API access by token exchange (see "You must review", item 1). |
| \`HOST\`, \`ALLOWED_HOSTS\`, \`PORT\` | Where the HTTP server listens and which hostnames it answers to. |
| \`RATE_LIMIT_PER_MINUTE\` | Requests per caller per minute; 0 turns the limiter off. |

Run behind a TLS-terminating proxy or platform; the server itself speaks plain HTTP.

## You must review

1. **Whose permissions do API calls use?** Two modes, set by \`${envPrefix}_UPSTREAM_AUTH\`:
   - \`shared\` (default): every call uses the one credential in the environment. Right for local use and for a deployment serving a single account. With OAuth sign-in on, the server refuses to start in this mode unless you set \`${envPrefix}_ALLOW_SHARED_CREDENTIAL=1\`, because every signed-in user would get that credential's access.
   - \`token_exchange\`: each call uses a credential for the signed-in user, obtained from your authorization server by OAuth token exchange (RFC 8693; needs \`OAUTH_TOKEN_ENDPOINT\`, \`OAUTH_CLIENT_ID\`, \`OAUTH_CLIENT_SECRET\`). Use this for one hosted connector serving many accounts. Your authorization server must support token exchange; if it does not, replace \`userCredential\` in \`src/upstream.ts\` with your own lookup of the user's API credential. Never forward the token the client presented to this server.
2. **Least privilege.** Give the connector's credential only the scopes its tools need. The connector must never be able to do more than the user it acts for.
3. **Write tools.** ${writes.length === 0 ? "This connector has none." : `Review each of: ${writes.map(tool => `\`${tool.name}\``).join(", ")}. Remove any that should not be reachable from an AI assistant.`}
4. **Untrusted content.** Text returned by the API (comments, descriptions, messages written by third parties) can contain instructions aimed at the AI model. Keep destructive tools behind user confirmation, and prefer read-only mode where that risk is high.
5. **Sensitive fields.** Tools return API responses as-is. If responses include personal data or secrets your users should not expose to an assistant, filter those fields in \`callOperation\` in \`src/api.ts\`.
6. **Logs.** Send stderr to your log system and alert on spikes in failed calls or 401s.
7. **Dependencies.** Run \`npm audit\` in CI and keep the MCP SDK current.
8. **Reporting.** Publish a contact for security reports.

Checked against ${spec.title} version ${spec.version}.
`;
}

function smokeFile(tools: PlannedTool[], envVars: GeneratedProject["envVars"], envPrefix: string): string {
  const safe = tools.find(tool => tool.annotations.readOnlyHint && (tool.inputSchema.required as string[]).length === 0);
  const envLines = [...envVars.map(v => v.name), `${envPrefix}_BASE_URL`]
    .map(name => `      ...(process.env.${name} ? { ${name}: process.env.${name} } : {})`)
    .join(",\n");
  return `/**
 * Self-check: starts the built server over stdio, lists its tools, and calls one read-only tool.
 * Run with: npm run build && npm run smoke   (needs the same environment variables as the server)
 */
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...getDefaultEnvironment(),
${envLines}
    }
  })
);

const { tools } = await client.listTools();
assert.equal(tools.length, ${tools.length}, "unexpected number of tools");
for (const tool of tools) assert.ok(tool.description && tool.description.length > 20, \`\${tool.name} needs a description\`);
console.error(\`Listed \${tools.length} tools\`);
${
  safe
    ? `
const result = await client.callTool({ name: ${lit(safe.name)}, arguments: {} });
const first = (result.content as { type: string; text?: string }[])[0];
assert.ok(!result.isError, \`${safe.name} failed: \${first?.text}\`);
console.error(\`${safe.name} OK: \${first?.text?.slice(0, 200)}\`);

// Unknown arguments must come back as a tool error the model can read
const invalid = await client.callTool({ name: ${lit(safe.name)}, arguments: { not_a_real_argument: 1 } });
assert.equal(invalid.isError, true, "unknown arguments should be rejected");
`
    : `
// No read-only tool without required arguments was found; add a call with realistic arguments here.
`
}
await client.close();
console.error("Smoke test passed");
`;
}

function readmeFile(project: Omit<GeneratedProject, "files">, spec: ParsedSpec, envPrefix: string): string {
  const envTable = [...project.envVars, { name: `${envPrefix}_BASE_URL`, required: false, purpose: `Overrides the API base URL (default \`${spec.baseUrl}\`)` }]
    .map(v => `| \`${v.name}\` | ${v.required ? "yes" : "no"} | ${v.purpose} |`)
    .join("\n");
  const toolTable = project.tools
    .map(tool => `| \`${tool.name}\` | ${tool.method} ${tool.path} | ${tool.annotations.readOnlyHint ? "read" : tool.annotations.destructiveHint ? "write (destructive)" : "write"} |`)
    .join("\n");
  const envExample = project.envVars.map(v => `"${v.name}": "..."`).join(", ");

  return `# ${project.packageName}

MCP connector for **${spec.title}** (API version ${spec.version}). It lets AI assistants that speak the Model Context Protocol call the API through ${project.tools.length} tools.

Generated by connector-forge-mcp-server from the OpenAPI spec. It builds and runs as generated; the "Before you ship" list below says what to review.

## Run it

\`\`\`bash
npm install
npm run build
npm start                    # stdio, for local MCP hosts
TRANSPORT=http npm start     # Streamable HTTP on http://127.0.0.1:3000/mcp
npm run smoke                # self-check against the built server
\`\`\`

Requires Node.js 20.3 or later.

| Variable | Required | Purpose |
|---|---|---|
${envTable}
| \`TRANSPORT\` | no | \`http\` for Streamable HTTP; anything else is stdio |
| \`PORT\`, \`HOST\`, \`ALLOWED_HOSTS\` | no | HTTP listen settings (default \`127.0.0.1:3000\`) |
| \`${envPrefix}_READ_ONLY\`, \`${envPrefix}_DISABLED_TOOLS\` | no | Limit which tools exist |
| \`MCP_AUTH_TOKEN\` or \`OAUTH_*\` + \`MCP_SERVER_URL\` | for public HTTP | Who may call the server (see SECURITY.md) |

### Add it to a local MCP host

\`\`\`json
{
  "mcpServers": {
    "${project.prefix}": {
      "command": "node",
      "args": ["/absolute/path/to/${project.packageName}/dist/index.js"],
      "env": { ${envExample} }
    }
  }
}
\`\`\`

## Tools

| Tool | API call | Kind |
|---|---|---|
${toolTable}

## Before you ship

1. **Read every tool description** in \`src/tools/\`. They come from the spec's summaries; the model relies on them to pick the right tool, so say when to use each one and give an example.
2. **Trim the tool list.** Remove tools your users will not need; fewer, clearer tools work better than full API coverage.
3. **Add workflow tools** for common multi-step jobs (for example "find a customer and list their open invoices") next to the one-call-per-endpoint tools.
4. **Check pagination.** List tools pass the API's own paging parameters through. Make sure their descriptions tell the model how to get the next page.
5. **Review write tools.** Tools marked destructive ask MCP hosts to confirm with the user; check the annotations match what each endpoint really does.
6. **Run the smoke test** with real credentials, then try the server in the MCP Inspector: \`npx @modelcontextprotocol/inspector node dist/index.js\`.

## Safety and security

See **SECURITY.md** for the full list. In short:

- \`${envPrefix}_READ_ONLY=1\` removes every write tool; \`${envPrefix}_DISABLED_TOOLS\` removes specific ones.
- Over HTTP the server refuses to listen publicly without authentication. Use \`MCP_AUTH_TOKEN\` (single tenant) or OAuth (\`OAUTH_ISSUER\`, \`OAUTH_JWKS_URL\`, \`MCP_SERVER_URL\`) for per-user sign-in.
- For one hosted connector serving many accounts, set \`${envPrefix}_UPSTREAM_AUTH=token_exchange\` so each user acts with their own permissions. The server refuses to combine OAuth sign-in with a shared credential unless you explicitly allow it.

## Deploy

\`\`\`bash
docker build -t ${project.packageName} .
docker run -p 3000:3000 --env-file .env -e ALLOWED_HOSTS=mcp.yourproduct.com ${project.packageName}
\`\`\`

The image listens on all interfaces, so it will not start without \`ALLOWED_HOSTS\` and an authentication mode. Put it behind HTTPS. \`.github/workflows/ci.yml\` builds the project and fails on known high-severity vulnerabilities.
${spec.auth.note ? `\n> ${spec.auth.note}\n` : ""}`;
}

// ---- Entry point ----

export function generateProject(rawSpec: ParsedSpec, operations: Operation[], serviceName: string): GeneratedProject {
  // The title is embedded in generated source, so strip characters that could break out of strings or comments
  const spec = { ...rawSpec, title: rawSpec.title.replace(/[`$\\"'*<>{}]/g, "").trim() || "API" };
  const prefix = servicePrefix(serviceName);
  const envPrefix = prefix.toUpperCase();
  const packageName = `${prefix.replace(/_/g, "-")}-mcp-server`;
  const tools = planTools(spec, operations, prefix);
  const auth = authPlan(spec.auth, envPrefix);

  const groups = new Map<string, { op: Operation; tool: PlannedTool }[]>();
  operations.forEach((op, index) => {
    const tool = tools[index];
    if (!groups.has(tool.group)) groups.set(tool.group, []);
    groups.get(tool.group)?.push({ op, tool });
  });

  const files: GeneratedFile[] = [];
  const groupNames = [...groups.keys()].sort();
  for (const group of groupNames) {
    const entries = groups.get(group) ?? [];
    files.push({
      path: `src/tools/${group}.ts`,
      content: `import * as z from "zod/v4";
import type { ToolDef } from "../api.js";

export const ${camel(group)}Tools: ToolDef[] = [
${entries.map(({ op, tool }) => toolEntry(op, tool)).join(",\n")}
];
`
    });
  }
  files.push({
    path: "src/tools/index.ts",
    content: `import type { ToolDef } from "../api.js";
${groupNames.map(group => `import { ${camel(group)}Tools } from "./${group}.js";`).join("\n")}

/** Every tool the server registers. Remove a group or filter this list to expose fewer tools. */
export const allTools: ToolDef[] = [${groupNames.map(group => `...${camel(group)}Tools`).join(", ")}];
`
  });

  const firstList = tools.find(tool => tool.annotations.readOnlyHint && /_(list|search)_/.test(tool.name))?.name;
  const project = { packageName, prefix, envVars: auth.envVars, tools };

  files.push(
    { path: "src/api.ts", content: apiFile(spec, envPrefix, auth.code, firstList) },
    { path: "src/index.ts", content: indexFile(packageName, spec, envPrefix) },
    { path: "src/security.ts", content: securityFile(envPrefix) },
    { path: "src/upstream.ts", content: upstreamFile(envPrefix, spec) },
    { path: "Dockerfile", content: DOCKERFILE },
    { path: ".dockerignore", content: "node_modules\ndist\n.env\n.git\n" },
    { path: ".github/workflows/ci.yml", content: CI_WORKFLOW },
    { path: "SECURITY.md", content: securityDoc(packageName, spec, envPrefix, tools) },
    { path: "scripts/smoke.ts", content: smokeFile(tools, auth.envVars, envPrefix) },
    { path: "README.md", content: readmeFile(project, spec, envPrefix) },
    {
      path: ".env.example",
      content: `${auth.envVars.map(v => `# ${v.purpose}\n${v.name}=`).join("\n")}\n# Optional: override the API base URL\n# ${envPrefix}_BASE_URL=${spec.baseUrl}\n`
    },
    { path: ".gitignore", content: "node_modules\ndist\n.env\n" },
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: packageName,
          version: "1.0.0",
          description: `MCP server for ${spec.title}`,
          type: "module",
          bin: { [packageName]: "dist/index.js" },
          files: ["dist"],
          scripts: { build: "tsc", start: "node dist/index.js", dev: "tsx watch src/index.ts", smoke: "tsx scripts/smoke.ts" },
          engines: { node: ">=20.3" },
          dependencies: {
            "@modelcontextprotocol/express": "^2.0.2",
            "@modelcontextprotocol/node": "^2.1.1",
            "@modelcontextprotocol/server": "^2.3.1",
            express: "^5.1.0",
            jose: "^6.1.0",
            zod: "^4.2.0"
          },
          devDependencies: {
            "@modelcontextprotocol/client": "^2.3.1",
            "@types/express": "^5.0.0",
            "@types/node": "^24.0.0",
            tsx: "^4.19.2",
            typescript: "^5.9.3"
          }
        },
        null,
        2
      )}\n`
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "Node16",
            moduleResolution: "Node16",
            lib: ["ES2022"],
            outDir: "./dist",
            rootDir: "./src",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            declaration: true,
            sourceMap: true
          },
          include: ["src/**/*"]
        },
        null,
        2
      )}\n`
    }
  );

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...project, files };
}
