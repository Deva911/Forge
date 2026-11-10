/**
 * Turns a GraphQL schema (SDL text or an introspection result) into the same
 * operation list the OpenAPI parser produces: one operation per Query field
 * (read) and per Mutation field (write), each with a fixed query document.
 */
import {
  buildClientSchema,
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isInterfaceType,
  isScalarType,
  isUnionType,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type IntrospectionQuery
} from "graphql";
import { ACTION_VERBS, snakeCase, titleCase, uniqueName } from "./naming.js";
import type { AuthScheme, JsonSchema, Operation, Param, ParsedSpec } from "./spec.js";

const MAX_SELECTION_DEPTH = 3;
const MAX_FIELDS_PER_LEVEL = 25;
const DESTRUCTIVE = /(^|_)(delete|remove|destroy|purge|revoke|cancel)(_|$)/;

function loadSchema(text: string): GraphQLSchema {
  const trimmed = text.trimStart();
  try {
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as { data?: IntrospectionQuery } & Partial<IntrospectionQuery>;
      const introspection = parsed.data ?? (parsed as IntrospectionQuery);
      if (!introspection.__schema) throw new Error("no __schema key");
      return buildClientSchema(introspection);
    }
    return buildSchema(text, { assumeValidSDL: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`graphql_schema is not valid GraphQL SDL or an introspection result: ${reason}`);
  }
}

/** JSON Schema for a GraphQL input type, used for tool arguments. */
function inputSchema(type: GraphQLInputType, stack: string[], depth: number): JsonSchema {
  if (isNonNullType(type)) return inputSchema(type.ofType, stack, depth);
  if (isListType(type)) return { type: "array", items: inputSchema(type.ofType, stack, depth + 1) };
  if (isEnumType(type)) return { type: "string", enum: type.getValues().map(value => value.name) };
  if (isScalarType(type)) {
    switch (type.name) {
      case "Int":
        return { type: "integer" };
      case "Float":
        return { type: "number" };
      case "Boolean":
        return { type: "boolean" };
      case "String":
        return { type: "string" };
      case "ID":
        return { type: "string", description: "ID" };
      default:
        // Custom scalars (dates, money, JSON) have no declared shape
        return /json/i.test(type.name) ? {} : { type: "string", description: `${type.name} value` };
    }
  }
  if (isInputObjectType(type)) {
    if (depth > 5 || stack.includes(type.name)) return { type: "object" };
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const field of Object.values(type.getFields())) {
      const schema = inputSchema(field.type, [...stack, type.name], depth + 1);
      properties[field.name] = field.description ? { ...schema, description: field.description } : schema;
      if (isNonNullType(field.type) && field.defaultValue === undefined) required.push(field.name);
    }
    return { type: "object", properties, required };
  }
  return {};
}

/** A default selection set: scalar fields, plus nested objects down to a fixed depth. */
function selection(type: GraphQLOutputType, stack: string[], depth: number): string {
  const named = getNamedType(type);
  if (isLeafType(named)) return "";
  if (isUnionType(named)) return "{ __typename }";
  if (!isObjectType(named) && !isInterfaceType(named)) return "";
  if (stack.includes(named.name)) return "";

  const parts: string[] = [];
  for (const field of Object.values(named.getFields())) {
    if (parts.length >= MAX_FIELDS_PER_LEVEL) break;
    if (field.deprecationReason) continue;
    // A field with a required argument cannot be selected without a value
    if (field.args.some(arg => isNonNullType(arg.type) && arg.defaultValue === undefined)) continue;
    const inner = getNamedType(field.type);
    if (isLeafType(inner)) {
      parts.push(field.name);
    } else if (depth < MAX_SELECTION_DEPTH) {
      const sub = selection(field.type, [...stack, named.name], depth + 1);
      if (sub) parts.push(`${field.name} ${sub}`);
    }
  }
  return parts.length > 0 ? `{ ${parts.join(" ")} }` : "{ __typename }";
}

function toolName(field: string, kind: "query" | "mutation", returnsList: boolean): string {
  let words = snakeCase(field).split("_").filter(Boolean);
  if (words.length === 0) words = ["field"];
  if (!ACTION_VERBS.includes(words[0])) {
    // Noun-verb names (productCreate) read better verb-first
    const last = words[words.length - 1];
    if (words.length > 1 && ACTION_VERBS.includes(last)) words = [last, ...words.slice(0, -1)];
    else words = [kind === "mutation" ? "run" : returnsList ? "list" : "get", ...words];
  }
  return words.join("_").slice(0, 48).replace(/_+$/, "");
}

function returnsMany(type: GraphQLOutputType): boolean {
  if (isNonNullType(type)) return returnsMany(type.ofType);
  if (isListType(type)) return true;
  return /Connection$/.test(getNamedType(type).name);
}

export function parseGraphQL(text: string, id: string, endpoint: string, title: string, authHeader: string | undefined): ParsedSpec {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("graphql_endpoint must be the full URL the API accepts queries at, e.g. 'https://api.acme.com/graphql'.");
  }
  const schema = loadSchema(text);
  const warnings: string[] = [];
  const operations: Operation[] = [];
  const used = new Set<string>();

  const roots: ["query" | "mutation", Record<string, GraphQLField<unknown, unknown>>][] = [
    ["query", schema.getQueryType()?.getFields() ?? {}],
    ["mutation", schema.getMutationType()?.getFields() ?? {}]
  ];
  if (schema.getSubscriptionType()) warnings.push("Subscriptions are not supported and were skipped.");

  for (const [kind, fields] of roots) {
    for (const field of Object.values(fields)) {
      const usedArgs = new Set<string>();
      const params: Param[] = field.args.map(arg => ({
        arg: uniqueName(snakeCase(arg.name) || "arg", usedArgs),
        name: arg.name,
        in: "query" as const,
        required: isNonNullType(arg.type) && arg.defaultValue === undefined,
        description: arg.description ?? undefined,
        schema: inputSchema(arg.type, [], 0)
      }));

      const base = uniqueName(toolName(field.name, kind, returnsMany(field.type)), used);
      const variables = field.args.map(arg => `$${arg.name}: ${String(arg.type)}`).join(", ");
      const call = field.args.map(arg => `${arg.name}: $${arg.name}`).join(", ");
      const operationName = base.replace(/(^|_)([a-z0-9])/g, (_, __, char: string) => char.toUpperCase());
      const document = `${kind} ${operationName}${variables ? `(${variables})` : ""} { ${field.name}${call ? `(${call})` : ""} ${selection(field.type, [], 0)} }`
        .replace(/\s+/g, " ")
        .trim();

      operations.push({
        operationId: field.name,
        method: kind === "query" ? "QUERY" : "MUTATION",
        path: field.name,
        summary: field.description?.split("\n")[0]?.trim() || titleCase(base),
        description: field.description ?? undefined,
        tags: [kind === "query" ? "queries" : "mutations"],
        params,
        deprecated: Boolean(field.deprecationReason),
        baseToolName: base,
        title: titleCase(base),
        graphql: { document, kind, destructive: kind === "mutation" && DESTRUCTIVE.test(snakeCase(field.name)) }
      });
    }
  }
  if (operations.length === 0) throw new Error("The GraphQL schema has no Query or Mutation fields to turn into tools.");
  warnings.push("Each tool returns a default set of fields chosen from the schema. Edit the query text in src/tools/ to return exactly what your users need.");
  if (url.protocol !== "https:") warnings.push("graphql_endpoint is not https. The generated connector refuses non-https APIs.");

  const auth: AuthScheme = authHeader ? { kind: "apiKeyHeader", name: authHeader } : { kind: "bearer" };
  return { id, title, version: "graphql", baseUrl: endpoint.replace(/\/+$/, ""), auth, operations, warnings };
}
