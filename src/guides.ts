/** Short, practical guides for teams building a connector for their own product. */

export const GUIDE_TOPICS = ["overview", "tool_design", "auth", "security", "hosting", "testing", "no_openapi", "launch_checklist"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export const GUIDES: Record<GuideTopic, { title: string; body: string }> = {
  overview: {
    title: "Building an MCP connector for your product",
    body: `An MCP connector is a small server that exposes your product's API as tools an AI assistant can call. One connector works with every MCP-capable assistant.

## The path with connector-forge

1. **forge_analyze_api** with your OpenAPI spec: see the base URL, auth scheme, and every operation with a proposed tool name.
2. **Choose a first set of tools.** Start with 10 to 25 operations that cover what users actually ask for. A read-only first version (read_only=true) is the safest launch.
3. **forge_generate_connector**: get a complete TypeScript project that builds and runs as generated.
4. **Refine by hand**: rewrite tool descriptions, add one or two workflow tools, and tune list tools (see topic 'tool_design').
5. **forge_lint_tools** on the result, and again whenever tools change.
6. **Test** with real credentials (topic 'testing'), then decide how to host it (topics 'auth' and 'hosting').

## Local or hosted?

- **Local (stdio)**: the user runs the server on their machine with their own API key. Fastest to ship; best for developer tools.
- **Hosted (Streamable HTTP)**: you run one server at a URL and users sign in with OAuth. Needed for non-technical users and for web and mobile assistants.

Most platforms ship local first, then host.`
  },
  tool_design: {
    title: "Designing tools a model can use well",
    body: `The model sees only each tool's name, description, and argument schema. Those three things decide whether your connector works.

## Names
- snake_case, product prefix, verb first: acme_list_invoices, acme_create_invoice.
- Keep sibling tools parallel (list_x / get_x / create_x / update_x / delete_x).

## Descriptions
- First sentence: what it does. Then what it returns, and when to use a different tool instead.
- Add one or two example requests mapped to arguments.
- Describe every argument, with format and an example value ("ISO 8601 date, e.g. 2026-01-31").

## Fewer, better tools
- Do not mirror the whole API. Each tool definition costs context on every request, and near-duplicate tools cause wrong picks.
- Add workflow tools for common multi-step jobs so the model makes one call instead of five.

## Responses
- Return what the model needs for the next step, not the raw API payload: names with IDs, human-readable dates, no internal metadata.
- Paginate lists (limit plus offset or cursor), default to 20-50 items, and say how to get the next page.
- Cap response size (about 25,000 characters) by returning fewer items, never by cutting JSON mid-object.

## Errors
- Return errors as tool results the model can read, and say how to recover: "Not found. acme_search_customers returns valid customer IDs."
- Never leak stack traces, tokens, or internal hostnames.

## Annotations
- readOnlyHint for tools that change nothing; destructiveHint for deletes and overwrites; idempotentHint when repeating is safe. Clients use these to decide when to ask the user first. They are hints, not access control: enforce permissions in your API.`
  },
  auth: {
    title: "Authentication",
    body: `## Local connector (stdio)
- Read the user's API key or token from an environment variable. Never hard-code it, log it, or return it in a tool result.
- Fail at startup with a clear message when it is missing.

## Hosted connector (Streamable HTTP)
- Use OAuth 2.1 with PKCE so each user signs in as themselves. The connector is an OAuth *resource server*: it validates the bearer token on every request and serves protected-resource metadata so clients can discover your authorization server.
- Accept only tokens issued for the connector itself (check the audience / resource). Do not pass a token the client sent you straight through to another service.
- Call your API on the user's behalf with that user's permissions. The connector must never be able to do more than the signed-in user can.
- Scope tokens narrowly; offer read-only scopes.

## Either way
- Treat tool arguments as untrusted input: validate them, and build URLs and queries with proper encoding.
- Text your API returns (ticket bodies, comments, web content) can contain instructions aimed at the model. Return it as data, and keep destructive tools behind user confirmation.

The generated project uses environment-variable credentials. Its README section "Hosting it for your users" lists what to change for per-user OAuth; the MCP TypeScript SDK ships requireBearerAuth and OAuth examples for this.`
  },
  security: {
    title: "Safety and security of a connector",
    body: `A connector gives an AI model the ability to act on your product. Three questions decide whether it is safe: who is calling, what can they do, and what can go wrong with the content.

## What forge_generate_connector builds in
- Credentials only from environment variables; startup fails if they are missing; never logged or returned.
- https-only upstream API, no redirects followed, 30-second timeout, response size cap.
- Strict argument schemas on every tool; unknown arguments rejected; path values encoded.
- HTTP mode fails closed: no public listening without authentication. Two modes: a static bearer secret (single tenant) or OAuth, verifying each JWT's signature, issuer, expiry, and audience, and publishing protected-resource metadata so clients can find your sign-in.
- Host and Origin validation, per-caller rate limit, one audit line per tool call (no arguments or data).
- Switches: <PREFIX>_READ_ONLY=1 removes all write tools; <PREFIX>_DISABLED_TOOLS removes specific ones.
- Read/write/destructive annotations on every tool so clients can ask users to confirm.
- A SECURITY.md in the project listing all of this plus what is left to review.

## What you still own
1. **Per-user permissions.** By default the generated code calls your API with one credential. For one hosted connector serving many accounts, set <PREFIX>_UPSTREAM_AUTH=token_exchange so each call uses the signed-in user's own credential; this needs an authorization server that supports OAuth token exchange. The connector refuses to start with OAuth sign-in and a shared credential unless you explicitly allow it. Never forward the client's token for the connector to another service, and never let the connector do more than the user can.
2. **Least privilege.** Narrow scopes for the connector's credential; offer read-only scopes.
3. **Which write tools exist at all.** Review each; launch read-only if unsure.
4. **Prompt injection.** Text your API returns (comments, tickets, pages) may contain instructions aimed at the model. Keep destructive actions behind user confirmation and do not combine untrusted content, private data, and outbound actions without a human in the loop.
5. **Data exposure.** Filter personal or secret fields out of tool results.
6. **Operations.** TLS in front, logs and alerts, dependency updates, a security contact, and your own review or penetration test before launch.

No generator can certify a deployment; the generated SECURITY.md is the starting checklist for your review.`
  },
  hosting: {
    title: "Hosting a remote connector",
    body: `- Transport: Streamable HTTP at a single endpoint such as https://mcp.yourproduct.com/mcp. Skip the older HTTP+SSE transport for new servers.
- Keep the server stateless (a fresh server object per request) so it scales horizontally behind a normal load balancer.
- Serve HTTPS only. Validate the Host and Origin headers; bind to 127.0.0.1 in development.
- Apply your API's rate limits per user, and add a request timeout to every upstream call.
- Log tool name, duration, and status per call, but not arguments or responses that may contain user data.
- Version the connector with your API. Adding tools is safe; renaming or removing them breaks saved workflows, so deprecate first.
- Publish setup docs: the server URL, how sign-in works, the scopes, and a table of tools.

The generated project runs this way with TRANSPORT=http; set HOST and ALLOWED_HOSTS and add authentication before exposing it.`
  },
  testing: {
    title: "Testing a connector",
    body: `1. **Build and smoke test**: \`npm run build && npm run smoke\` in the generated project starts the server, lists tools, and calls a read-only one.
2. **Inspect by hand**: \`npx @modelcontextprotocol/inspector node dist/index.js\` to call each tool and read the output as the model will.
3. **Lint**: pass the server's tools/list result to forge_lint_tools and fix errors and warnings.
4. **Evaluate with a model**: write about 10 realistic, read-only questions whose answers need several tool calls ("Which customer had the most refunds last quarter?"), with one verifiable answer each. Run an assistant against the connector and see where it picks the wrong tool, passes wrong arguments, or drowns in output. Fix descriptions and responses, then rerun.
5. **Failure cases**: bad credentials, missing permissions, unknown IDs, rate limits, and a slow upstream. Each should give the model a message it can act on.
6. **Safety**: confirm write tools are annotated, deletes need confirmation in your target clients, and a user cannot reach another tenant's data.`
  },
  no_openapi: {
    title: "If you have no OpenAPI spec",
    body: `connector-forge reads OpenAPI 3.x (and most Swagger 2.0) in JSON or YAML, and GraphQL schemas. Without either:

- **Check your framework**: FastAPI, NestJS, Spring (springdoc), ASP.NET, Rails (rswag), and Django REST Framework (drf-spectacular) can emit a spec from existing code.
- **Write a small one by hand** for just the 10 to 20 endpoints the connector needs: path, method, parameters, request body, and a one-line summary each. A partial spec is fine; pass it as \`spec\`.
- **GraphQL APIs**: pass the schema as graphql_schema (SDL or an introspection result) with graphql_endpoint; each query and mutation becomes one tool.
- **gRPC APIs**: describe the operations you want as REST-style endpoints in a small OpenAPI document that points at an HTTP gateway.
- **Postman collection or HAR file**: convert it to OpenAPI with an existing converter, review the result, then analyze it here.`
  },
  launch_checklist: {
    title: "Launch checklist",
    body: `- [ ] 40 or fewer tools, each with a product prefix, a verb-first name, and a description that says when to use it
- [ ] Every argument described; list tools paginate; responses capped in size
- [ ] Annotations set; destructive tools marked
- [ ] forge_lint_tools reports no errors
- [ ] Credentials come from the environment (local) or per-user OAuth (hosted); nothing secret in logs or tool results
- [ ] Hosted: HTTPS, Host/Origin validation, token audience check, per-user rate limits
- [ ] Smoke test passes; tried in MCP Inspector and in at least one real assistant
- [ ] About 10 evaluation questions pass with a model driving the tools
- [ ] README: what it does, setup, environment variables or sign-in, tool table, permissions needed
- [ ] A support contact and a way to report security issues
- [ ] Plan for API changes: versioning and deprecation of tools`
  }
};
