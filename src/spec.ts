/**
 * Loads an OpenAPI (3.x, with light Swagger 2.0 support) document and turns it
 * into a flat list of operations with proposed MCP tool names.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse as parseYaml } from "yaml";
import { MAX_SPEC_BYTES, SPEC_CACHE_SIZE } from "./constants.js";
import { parseGraphQL } from "./graphql.js";
import { snakeCase, titleCase, toolNameFor, uniqueName } from "./naming.js";

export type JsonSchema = Record<string, unknown>;

export interface Param {
  /** Argument name exposed to the model (safe identifier) */
  arg: string;
  /** Real parameter name sent to the API */
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface Operation {
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  params: Param[];
  body?: { required: boolean; contentType: string; schema: JsonSchema };
  deprecated: boolean;
  /** Tool name without the service prefix, e.g. "list_users" */
  baseToolName: string;
  title: string;
  /** Set for GraphQL APIs: the query text this tool sends */
  graphql?: { document: string; kind: "query" | "mutation"; destructive: boolean };
}

export interface AuthScheme {
  kind: "bearer" | "basic" | "apiKeyHeader" | "apiKeyQuery" | "none";
  /** Header or query parameter name for apiKey schemes */
  name?: string;
  /** Human-readable note, e.g. the OAuth flows the spec declares */
  note?: string;
}

export interface ParsedSpec {
  id: string;
  title: string;
  version: string;
  description?: string;
  baseUrl: string;
  auth: AuthScheme;
  operations: Operation[];
  warnings: string[];
}

export interface SpecSource {
  spec?: string;
  spec_url?: string;
  spec_id?: string;
  graphql_schema?: string;
  graphql_endpoint?: string;
  graphql_auth_header?: string;
  service_name?: string;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;
const cache = new Map<string, ParsedSpec>();

// ---- Loading ----

export async function loadSpec(source: SpecSource, signal: AbortSignal): Promise<ParsedSpec> {
  const given = [source.spec, source.spec_url, source.spec_id, source.graphql_schema].filter(value => value !== undefined);
  if (given.length !== 1) {
    throw new Error("Provide exactly one of: spec (the OpenAPI document text), spec_url, graphql_schema, or spec_id (returned by forge_analyze_api).");
  }

  if (source.graphql_schema !== undefined) {
    if (!source.graphql_endpoint) throw new Error("graphql_schema needs graphql_endpoint: the URL the API accepts queries at, e.g. 'https://api.acme.com/graphql'.");
    if (Buffer.byteLength(source.graphql_schema) > MAX_SPEC_BYTES) throw new Error(`The schema is larger than ${MAX_SPEC_BYTES / 1_000_000} MB.`);
    const key = [source.graphql_schema, source.graphql_endpoint, source.graphql_auth_header ?? "", source.service_name ?? ""].join("\u0000");
    const graphqlId = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const hit = cache.get(graphqlId);
    if (hit) return hit;
    const parsed = parseGraphQL(source.graphql_schema, graphqlId, source.graphql_endpoint, source.service_name ?? "GraphQL API", source.graphql_auth_header);
    remember(parsed);
    return parsed;
  }

  if (source.spec_id !== undefined) {
    const hit = cache.get(source.spec_id);
    if (!hit) {
      throw new Error(
        `spec_id '${source.spec_id}' is not cached (the cache is in-memory and holds the last ${SPEC_CACHE_SIZE} specs). Pass spec or spec_url again.`
      );
    }
    return hit;
  }

  const text = source.spec ?? (await fetchSpec(source.spec_url as string, signal));
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) {
    throw new Error(`The spec is larger than ${MAX_SPEC_BYTES / 1_000_000} MB. Split it by tag or remove unused paths, then try again.`);
  }
  const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const cached = cache.get(id);
  if (cached) return cached;

  const parsed = parseSpec(text, id, source.spec_url);
  remember(parsed);
  return parsed;
}

function remember(parsed: ParsedSpec): void {
  cache.set(parsed.id, parsed);
  if (cache.size > SPEC_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224
  );
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (process.env.FORGE_ALLOW_PRIVATE_URLS === "1") return;
  if (url.protocol !== "https:") throw new Error("spec_url must use https. Paste the document as `spec` instead if it is not served over https.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(entry => entry.address);
  if (addresses.some(isPrivateAddress)) {
    throw new Error("spec_url points at a private or loopback address, which this server does not fetch. Paste the document as `spec` instead.");
  }
}

async function fetchSpec(rawUrl: string, signal: AbortSignal): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`'${rawUrl}' is not a valid URL.`);
  }
  // Redirects are followed by hand so every hop is checked
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(url);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not fetch spec_url (${reason}). Check the URL, or paste the document as \`spec\`.`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      throw new Error(`spec_url returned HTTP ${response.status}. If the spec needs a login, download it and pass it as \`spec\`.`);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_SPEC_BYTES) throw new Error(`The spec is larger than ${MAX_SPEC_BYTES / 1_000_000} MB.`);
    return await response.text();
  }
  throw new Error("spec_url redirected too many times.");
}

// ---- Parsing ----

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Inlines local `#/...` references. Cycles and very deep schemas become open objects. */
function deref(node: unknown, root: Record<string, unknown>, stack: string[], depth: number): unknown {
  if (depth > 14) return {};
  if (Array.isArray(node)) return node.map(item => deref(item, root, stack, depth + 1));
  if (!isObject(node)) return node;

  const ref = node.$ref;
  if (typeof ref === "string") {
    if (!ref.startsWith("#/") || stack.includes(ref)) return {};
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = isObject(target) ? target[key] : undefined;
    }
    return deref(target ?? {}, root, [...stack, ref], depth + 1);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = deref(value, root, stack, depth + 1);
  return out;
}

function detectAuth(doc: Record<string, unknown>, warnings: string[]): AuthScheme {
  const components = isObject(doc.components) ? doc.components : {};
  const schemes = (isObject(components.securitySchemes) ? components.securitySchemes : doc.securityDefinitions) as unknown;
  if (!isObject(schemes) || Object.keys(schemes).length === 0) {
    warnings.push("No security scheme is declared. The generated connector sends no credentials; edit src/api.ts if the API needs them.");
    return { kind: "none" };
  }

  // Prefer the scheme the top-level `security` requirement names
  const required = Array.isArray(doc.security) && isObject(doc.security[0]) ? Object.keys(doc.security[0])[0] : undefined;
  const names = Object.keys(schemes);
  const chosen = required && names.includes(required) ? required : names[0];
  if (names.length > 1) {
    warnings.push(`The spec declares ${names.length} security schemes (${names.join(", ")}); the connector uses '${chosen}'.`);
  }

  const scheme = deref(schemes[chosen], doc, [], 0);
  if (!isObject(scheme)) return { kind: "none" };
  const type = str(scheme.type)?.toLowerCase();
  if (type === "http") {
    return str(scheme.scheme)?.toLowerCase() === "basic" ? { kind: "basic" } : { kind: "bearer" };
  }
  if (type === "basic") return { kind: "basic" };
  if (type === "apikey") {
    const name = str(scheme.name) ?? "X-API-Key";
    if (scheme.in === "query") return { kind: "apiKeyQuery", name };
    if (scheme.in === "header") return { kind: "apiKeyHeader", name };
    warnings.push("Cookie API keys are not supported; the connector sends the key as a bearer token instead.");
    return { kind: "bearer" };
  }
  if (type === "oauth2" || type === "openidconnect") {
    return {
      kind: "bearer",
      note: "The API uses OAuth. The generated connector reads an access token from an environment variable; see the 'auth' guide for per-user OAuth on a hosted connector."
    };
  }
  return { kind: "none" };
}

function baseUrlOf(doc: Record<string, unknown>, specUrl: string | undefined, warnings: string[]): string {
  let base: string | undefined;
  if (Array.isArray(doc.servers) && isObject(doc.servers[0])) {
    const server = doc.servers[0];
    base = str(server.url);
    if (base && isObject(server.variables)) {
      for (const [name, variable] of Object.entries(server.variables)) {
        const fallback = isObject(variable) ? String(variable.default ?? "") : "";
        base = base.replaceAll(`{${name}}`, fallback);
      }
    }
  } else if (typeof doc.host === "string") {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.includes("https") ? "https" : Array.isArray(doc.schemes) ? String(doc.schemes[0]) : "https";
    base = `${scheme}://${doc.host}${str(doc.basePath) ?? ""}`;
  }
  if (base && !/^https?:\/\//.test(base) && specUrl) {
    try {
      base = new URL(base, specUrl).toString();
    } catch {
      base = undefined;
    }
  }
  if (!base || !/^https?:\/\//.test(base)) {
    warnings.push("No absolute server URL in the spec. Set the base URL environment variable before running the connector.");
    return "https://api.example.com";
  }
  if (base.startsWith("http://")) {
    warnings.push(`The spec's server URL is plain http (${base}). The generated connector refuses non-https APIs; set the base URL environment variable to the https address.`);
  }
  return base.replace(/\/+$/, "");
}

function parseSpec(text: string, id: string, specUrl: string | undefined): ParsedSpec {
  let doc: unknown;
  try {
    doc = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`The spec is not valid JSON or YAML: ${reason}`);
  }
  if (!isObject(doc) || !isObject(doc.paths) || !(typeof doc.openapi === "string" || typeof doc.swagger === "string")) {
    throw new Error(
      "This does not look like an OpenAPI document (expected `openapi` or `swagger` and a `paths` object). If the platform has no OpenAPI spec, see forge_get_guide topic='no_openapi'."
    );
  }

  const warnings: string[] = [];
  const isSwagger2 = typeof doc.swagger === "string";
  const info = isObject(doc.info) ? doc.info : {};
  const operations: Operation[] = [];
  const usedNames = new Set<string>();

  for (const [path, rawItem] of Object.entries(doc.paths)) {
    const item = deref(rawItem, doc, [], 0);
    if (!isObject(item)) continue;
    const sharedParams = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;

      const params: Param[] = [];
      const usedArgs = new Set<string>(["body"]);
      let body: Operation["body"];
      const formFields: Record<string, unknown> = {};
      const formRequired: string[] = [];

      // Operation-level parameters override path-level ones with the same name and location
      const merged = new Map<string, Record<string, unknown>>();
      for (const raw of [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        if (isObject(raw) && typeof raw.name === "string") merged.set(`${String(raw.in)}:${raw.name}`, raw);
      }

      for (const raw of merged.values()) {
        const name = raw.name as string;
        const location = raw.in;
        const schema: JsonSchema = isObject(raw.schema) ? raw.schema : isSwagger2 ? pick(raw, ["type", "format", "enum", "items", "minimum", "maximum", "default"]) : {};
        if (location === "body" && isSwagger2) {
          body = { required: raw.required === true, contentType: "application/json", schema };
        } else if (location === "formData" && isSwagger2) {
          formFields[name] = { ...schema, description: raw.description };
          if (raw.required === true) formRequired.push(name);
        } else if (location === "path" || location === "query" || location === "header") {
          if (location === "header" && /^(authorization|accept|content-type)$/i.test(name)) continue;
          params.push({
            arg: uniqueName(snakeCase(name) || "param", usedArgs),
            name,
            in: location,
            required: location === "path" || raw.required === true,
            description: str(raw.description),
            schema
          });
        }
      }

      if (Object.keys(formFields).length > 0) {
        body = {
          required: formRequired.length > 0,
          contentType: "application/x-www-form-urlencoded",
          schema: { type: "object", properties: formFields, required: formRequired }
        };
      }

      if (isObject(op.requestBody) && isObject(op.requestBody.content)) {
        const content = op.requestBody.content;
        const types = Object.keys(content);
        const contentType = types.find(type => /json/i.test(type)) ?? types.find(type => type === "application/x-www-form-urlencoded");
        if (contentType && isObject(content[contentType])) {
          const media = content[contentType];
          body = { required: op.requestBody.required === true, contentType, schema: isObject(media.schema) ? media.schema : {} };
        } else if (types.length > 0) {
          warnings.push(`${method.toUpperCase()} ${path}: request body type ${types[0]} is not supported, so the tool has no body argument.`);
        }
      }

      // Every {placeholder} in the path needs an argument, even if the spec forgot to declare it
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        if (!params.some(param => param.in === "path" && param.name === match[1])) {
          params.push({ arg: uniqueName(snakeCase(match[1]) || "id", usedArgs), name: match[1], in: "path", required: true, schema: { type: "string" } });
        }
      }

      const operationId = str(op.operationId);
      const baseToolName = uniqueName(toolNameFor(method, path, operationId), usedNames);
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        summary: str(op.summary),
        description: str(op.description),
        tags: Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string") : [],
        params,
        body,
        deprecated: op.deprecated === true,
        baseToolName,
        title: str(op.summary) ?? titleCase(baseToolName)
      });
    }
  }

  if (operations.length === 0) throw new Error("The spec has no GET, POST, PUT, PATCH, or DELETE operations to turn into tools.");

  return {
    id,
    title: str(info.title) ?? "API",
    version: str(info.version) ?? "unknown",
    description: str(info.description),
    baseUrl: baseUrlOf(doc, specUrl, warnings),
    auth: detectAuth(doc, warnings),
    operations,
    warnings
  };
}

function pick(source: Record<string, unknown>, keys: string[]): JsonSchema {
  const out: JsonSchema = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

// ---- Selection ----

export interface Selection {
  include_tags?: string[];
  include_operations?: string[];
  read_only?: boolean;
  include_deprecated?: boolean;
}

export function selectOperations(spec: ParsedSpec, selection: Selection): Operation[] {
  const tags = selection.include_tags?.map(tag => tag.toLowerCase());
  const wanted = selection.include_operations?.map(name => name.toLowerCase());
  return spec.operations.filter(op => {
    if (op.deprecated && !selection.include_deprecated) return false;
    if (selection.read_only && !annotationsFor(op).readOnlyHint) return false;
    if (tags && !op.tags.some(tag => tags.includes(tag.toLowerCase()))) return false;
    if (wanted) {
      const keys = [op.baseToolName, op.operationId, `${op.method} ${op.path}`].filter((key): key is string => !!key).map(key => key.toLowerCase());
      // Also accept names that already carry the service prefix
      if (!wanted.some(name => keys.includes(name) || keys.some(key => name.endsWith(`_${key}`)))) return false;
    }
    return true;
  });
}

export function annotationsFor(op: Pick<Operation, "method" | "graphql">): { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } {
  if (op.graphql) {
    const read = op.graphql.kind === "query";
    return { readOnlyHint: read, destructiveHint: op.graphql.destructive, idempotentHint: read, openWorldHint: true };
  }
  const { method } = op;
  return {
    readOnlyHint: method === "GET",
    destructiveHint: method === "DELETE" || method === "PUT",
    idempotentHint: method === "GET" || method === "PUT" || method === "DELETE",
    openWorldHint: true
  };
}
