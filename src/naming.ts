/** Name helpers shared by the planner, the generator, and the linter. */

export const ACTION_VERBS = [
  "get", "list", "search", "find", "create", "add", "update", "set", "delete", "remove", "send", "upload", "download",
  "run", "start", "stop", "cancel", "archive", "restore", "move", "copy", "export", "import", "check", "validate",
  "count", "query", "fetch", "read", "write", "post", "put", "patch", "replace", "merge", "close", "open", "assign",
  "invite", "approve", "reject", "publish", "sync", "generate", "analyze", "lint", "plan", "submit", "retry", "refund",
  "capture", "attach", "link", "unlink", "enable", "disable", "rename", "reset", "revoke", "verify", "trigger", "execute",
  "resolve", "subscribe", "unsubscribe", "share", "pause", "resume", "deploy", "describe", "lookup", "render", "convert"
];

export function snakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function titleCase(snake: string): string {
  return snake
    .split("_")
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${name}_${n}`;
  used.add(candidate);
  return candidate;
}

function singular(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Proposes a verb-first tool name (without service prefix).
 * A usable operationId wins; otherwise the name is built from the method and path:
 *   GET /users -> list_users, GET /users/{id} -> get_user, POST /users/{id}/invites -> create_user_invite
 */
export function toolNameFor(method: string, path: string, operationId?: string): string {
  if (operationId) {
    const fromId = snakeCase(operationId);
    const firstWord = fromId.split("_")[0];
    const usable = fromId.length >= 3 && fromId.length <= 48;
    if (usable && ACTION_VERBS.includes(firstWord)) return fromId;
    // RPC-style paths (/chat.postMessage, /items:search) say nothing useful about the HTTP verb, so trust the operationId
    if (usable && /[.:]/.test(path.split("/").pop() ?? "")) return fromId;
  }

  const segments = path.split("/").filter(Boolean);
  const endsWithParam = segments.length > 0 && /^\{.*\}$/.test(segments[segments.length - 1]);
  const words = segments.filter(segment => !/^\{.*\}$/.test(segment) && !/^v\d+$/i.test(segment)).map(snakeCase).filter(Boolean);

  const verb = { get: endsWithParam ? "get" : "list", post: "create", put: "replace", patch: "update", delete: "delete" }[method.toLowerCase()] ?? method.toLowerCase();
  if (words.length === 0) return `${verb}_root`;

  const keepPlural = verb === "list";
  const nouns = words.slice(-3).map((word, index, kept) => (index === kept.length - 1 && keepPlural ? word : singular(word)));
  return `${verb}_${nouns.join("_")}`.slice(0, 48).replace(/_+$/, "");
}

/** Service prefix for tool names: "Acme Billing API" -> "acme_billing" */
export function servicePrefix(serviceName: string): string {
  const prefix = snakeCase(serviceName).replace(/_(api|mcp|server|connector)$/g, "").replace(/_(api|mcp|server|connector)$/g, "");
  return (prefix || "service").slice(0, 20).replace(/_+$/, "");
}
