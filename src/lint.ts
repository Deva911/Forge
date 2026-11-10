/**
 * Checks MCP tool definitions against tool-design practices that affect how
 * well a model can pick and call them. Works on any connector, in any language:
 * the input is the tool list a server returns from tools/list.
 */
import { RECOMMENDED_MAX_TOOLS } from "./constants.js";
import { ACTION_VERBS } from "./naming.js";

export interface ToolLike {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface Finding {
  severity: "error" | "warning" | "info";
  tool: string;
  rule: string;
  message: string;
  fix: string;
}

export interface LintReport {
  tool_count: number;
  score: number;
  errors: number;
  warnings: number;
  infos: number;
  detected_prefix: string | null;
  findings: Finding[];
}

const WRITE_VERBS = ["create", "add", "update", "set", "delete", "remove", "send", "upload", "replace", "patch", "post", "put", "write", "move", "archive", "cancel", "merge", "assign", "invite", "refund", "revoke", "reset", "deploy", "publish"];
const DELETE_VERBS = ["delete", "remove", "revoke", "reset", "purge", "destroy"];
const LIST_VERBS = ["list", "search", "find", "query"];
const PAGING_ARGS = /^(limit|offset|page|page_size|per_page|cursor|page_token|next_token|after|before|max_results|first|count|top|skip|size|starting_after)$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commonPrefix(names: string[]): string | null {
  if (names.length < 2) return null;
  const counts = new Map<string, number>();
  for (const name of names) {
    const first = name.split("_")[0];
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  const [prefix, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  // A leading verb shared by most tools is not a service prefix
  return count / names.length >= 0.6 && !ACTION_VERBS.includes(prefix) ? prefix : null;
}

export function lintTools(tools: ToolLike[], expectedPrefix?: string): LintReport {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], tool: string, rule: string, message: string, fix: string) =>
    findings.push({ severity, tool, rule, message, fix });

  const names = tools.map(tool => tool.name);
  const prefix = expectedPrefix?.replace(/_+$/, "") ?? commonPrefix(names);

  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) add("error", name, "duplicate-name", "Two tools share this name.", "Give every tool a unique name.");
    seen.add(name);
  }

  if (!prefix && tools.length > 1) {
    add("warning", "(server)", "service-prefix", "Tools do not share a service prefix.", "Prefix every tool with the product name, e.g. acme_list_orders, so they do not collide with other connectors.");
  }
  if (tools.length > RECOMMENDED_MAX_TOOLS) {
    add("warning", "(server)", "tool-count", `The server exposes ${tools.length} tools. Every tool definition costs the model context on each request.`, `Aim for ${RECOMMENDED_MAX_TOOLS} or fewer: drop rarely used endpoints and merge near-duplicates.`);
  }

  for (const tool of tools) {
    const { name } = tool;

    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      add("error", name, "name-format", "Name is not snake_case.", "Use lowercase letters, digits, and underscores, starting with a letter.");
    }
    if (name.length > 64) add("error", name, "name-length", `Name is ${name.length} characters; many clients cap names at 64.`, "Shorten the name.");
    if (prefix && !name.startsWith(`${prefix}_`)) {
      add("warning", name, "service-prefix", `Name does not start with '${prefix}_'.`, `Rename to ${prefix}_${name}.`);
    }

    const words = (prefix && name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : name).split("_");
    const verb = words[0];
    if (!ACTION_VERBS.includes(verb)) {
      add("info", name, "verb-first", `'${verb}' is not a common action verb.`, "Start the name (after the prefix) with a verb such as get, list, search, create, update, or delete.");
    }

    const description = tool.description?.trim() ?? "";
    if (description === "") {
      add("error", name, "description-missing", "No description. The model has only the name to decide when to call this tool.", "Describe what the tool does, what it returns, and when to use it.");
    } else if (description.length < 40) {
      add("warning", name, "description-short", `Description is only ${description.length} characters.`, "Say what it returns and when to use it instead of a sibling tool; add an example request.");
    } else if (description.length > 2000) {
      add("warning", name, "description-long", `Description is ${description.length} characters.`, "Keep it under about 1,000 characters; move reference detail into parameter descriptions.");
    }
    if (!tool.title) add("info", name, "title-missing", "No title.", "Add a short human-readable title for client UIs.");

    const schema = tool.inputSchema;
    const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
    if (schema !== undefined && (!isObject(schema) || schema.type !== "object")) {
      add("error", name, "schema-type", "inputSchema must be a JSON Schema with type 'object'.", "Wrap the arguments in an object schema.");
    }
    const undocumented = Object.entries(properties)
      .filter(([, property]) => !isObject(property) || typeof property.description !== "string" || property.description.trim() === "")
      .map(([key]) => key);
    if (undocumented.length > 0) {
      add("warning", name, "param-descriptions", `Arguments without a description: ${undocumented.join(", ")}.`, "Describe each argument, with its format and an example value.");
    }
    if (Object.keys(properties).length > 12) {
      add("info", name, "param-count", `${Object.keys(properties).length} arguments.`, "Tools with many arguments are called wrongly more often; split the tool or drop rarely used arguments.");
    }
    if (LIST_VERBS.includes(verb) && !Object.keys(properties).some(key => PAGING_ARGS.test(key))) {
      add("warning", name, "pagination", "List/search tool with no paging argument.", "Add limit plus offset or cursor, and return has_more with the next offset or cursor.");
    }

    const annotations = tool.annotations;
    if (!isObject(annotations)) {
      add("warning", name, "annotations-missing", "No annotations.", "Set readOnlyHint, destructiveHint, idempotentHint, and openWorldHint so clients know when to ask the user for confirmation.");
    } else {
      if (annotations.readOnlyHint === true && WRITE_VERBS.includes(verb)) {
        add("error", name, "annotations-readonly", `Marked read-only, but '${verb}' implies it changes data. Clients may run it without confirmation.`, "Set readOnlyHint to false, or rename the tool.");
      }
      if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
        add("error", name, "annotations-conflict", "Marked both read-only and destructive.", "A read-only tool cannot be destructive; fix one of the hints.");
      }
      if (DELETE_VERBS.includes(verb) && annotations.destructiveHint !== true && annotations.readOnlyHint !== true) {
        add("warning", name, "annotations-destructive", `'${verb}' implies data loss, but destructiveHint is not true.`, "Set destructiveHint to true.");
      }
      if (annotations.readOnlyHint === undefined) {
        add("info", name, "annotations-readonly-unset", "readOnlyHint is not set, so clients treat the tool as a write.", "Set readOnlyHint explicitly.");
      }
    }
  }

  const count = (severity: Finding["severity"]) => findings.filter(finding => finding.severity === severity).length;
  const errors = count("error");
  const warnings = count("warning");
  const infos = count("info");
  // Penalties are scaled by tool count so large and small servers are comparable
  const penalty = (errors * 10 + warnings * 3 + infos) / Math.max(1, tools.length);
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    tool_count: tools.length,
    score: Math.max(0, Math.round(100 - penalty * 8)),
    errors,
    warnings,
    infos,
    detected_prefix: prefix ?? null,
    findings
  };
}
