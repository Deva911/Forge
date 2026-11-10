/**
 * Acme Store API API client: one request helper that every tool calls.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { UPSTREAM_AUTH, userCredential } from "./upstream.js";

export const API_BASE_URL = (process.env.ACME_BASE_URL ?? "https://api.acme-store.example/v2").replace(/\/+$/, "");
export const API_LABEL = "Acme Store";
/** Tool responses stay under this many characters so they do not flood the model's context */
export const CHARACTER_LIMIT = 25_000;
const TIMEOUT_MS = 30_000;

const TOKEN = process.env.ACME_API_TOKEN;
const REQUIRED_ENV = ["ACME_API_TOKEN"];

function applyAuth(headers: Record<string, string>, _url: URL): void {
  headers.Authorization = `Bearer ${TOKEN}`;
}

/** Exits with a clear message when configuration is missing or unsafe. */
export function assertConfigured(): void {
  // With per-user credentials there is no shared credential to require
  const missing = UPSTREAM_AUTH === "shared" ? REQUIRED_ENV.filter(name => !process.env[name]) : [];
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  // Credentials must never travel over plain http, except to a local test server
  const base = new URL(API_BASE_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !local) {
    console.error(`ACME_BASE_URL must use https (got ${base.protocol}//${base.hostname}).`);
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
  const suffix = detail ? ` API said: ${detail}` : "";
  switch (status) {
    case 400:
    case 422:
      return `The Acme Store API rejected the request (HTTP ${status}). Check the argument values.${suffix}`;
    case 401:
      return `Authentication failed (HTTP 401). The connector's credentials are missing, invalid, or expired.${suffix}`;
    case 403:
      return `Permission denied (HTTP 403): these credentials cannot do that.${suffix}`;
    case 404:
      return `Not found (HTTP 404). Check the IDs in the request; acme_list_products returns valid ones.${suffix}`;
    case 429:
      return `Rate limit exceeded (HTTP 429). Wait a minute before making more requests.${suffix}`;
    default:
      return status >= 500
        ? `The Acme Store API had a server error (HTTP ${status}). Try again shortly.${suffix}`
        : `The Acme Store API returned HTTP ${status}.${suffix}`;
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(httpErrorMessage(status, detail));
  }
}

class GraphQLFailure extends Error {
  constructor(detail: string) {
    super(`The Acme Store API rejected the request: ${detail}. Check the argument values.`);
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
  return `${full.slice(0, CHARACTER_LIMIT)}\n\n[Response cut at ${CHARACTER_LIMIT} of ${full.length} characters. Narrow the request with filters or a smaller page size.]`;
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
      if (segment === "" || segment === "." || segment === "..") throw new Error(`'${segment}' is not a valid value for ${param.arg}.`);
      path = path.replace(`{${param.name}}`, encodeURIComponent(segment));
    }
    else if (param.in === "query") query.push([param.name, value]);
    else if (value !== undefined && value !== null) headers[param.name] = String(value);
  }

  const url = new URL(API_BASE_URL + path);
  if (!tool.graphql) for (const [name, value] of query) appendQuery(url, name, value);
  if (UPSTREAM_AUTH === "shared") applyAuth(headers, url);
  // Per-user mode: call the API as the signed-in user, never with a shared credential
  else headers.Authorization = `Bearer ${await userCredential(authInfo, signal)}`;

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
      throw new Error(`The Acme Store API did not respond within ${TIMEOUT_MS / 1000} seconds. Try again, or narrow the request.`);
    }
    throw new Error(`Could not reach the Acme Store API at ${API_BASE_URL}. Check the network and ACME_BASE_URL.`);
  }

  const raw = await response.text();
  if (!response.ok) throw new ApiError(response.status, raw.replace(/\s+/g, " ").slice(0, 500));
  if (raw.trim() === "") return { content: [{ type: "text" as const, text: `Done (HTTP ${response.status}, empty response).` }] };

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
    text = raw.length > CHARACTER_LIMIT ? `${raw.slice(0, CHARACTER_LIMIT)}\n\n[Response cut at ${CHARACTER_LIMIT} characters.]` : raw;
  }
  return { content: [{ type: "text" as const, text }] };
}
