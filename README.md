# connector-forge-mcp-server

An MCP connector that builds MCP connectors. A product or website that has an API but no MCP connector points an AI assistant at this server and its OpenAPI spec, and gets back a complete, runnable, security-hardened connector for its own product.

## What a platform does with it

1. Connect an MCP-capable assistant to this server.
2. Say: "Build an MCP connector for our API at https://api.ourproduct.com/openapi.json."
3. The assistant analyzes the API, proposes tools, generates the project, and reports lint findings.
4. The team reviews the generated `README.md` and `SECURITY.md`, runs `npm install && npm run build && npm run smoke`, and ships.

## Tools

| Tool | What it does |
|---|---|
| `forge_analyze_api` | Reads an OpenAPI 3.x or Swagger 2.0 spec (pasted text or https URL), or a GraphQL schema (SDL or introspection result). Reports base URL, auth scheme, and every operation with its proposed tool name. Returns a `spec_id` for later calls. |
| `forge_generate_connector` | Generates the connector project for the selected operations: returns files inline in batches, or writes them to disk. Includes a lint report. |
| `forge_lint_tools` | Scores any connector's tool definitions (any language) on naming, descriptions, argument docs, pagination, and annotations, with a fix for each finding. |
| `forge_get_guide` | Short guides: overview, tool_design, auth, security, hosting, testing, no_openapi, launch_checklist. |

There is also a prompt, `forge_build_connector`, that walks through the whole path.

## What the generated connector contains

A TypeScript project on the MCP SDK v2 that builds and runs as generated:

- **Connectivity**: one tool per selected API operation with typed argument schemas; stdio for local hosts and stateless Streamable HTTP for hosted use; bearer, basic, and API-key (header or query) authentication to the API; 30-second timeouts; error messages that tell the model how to recover; responses capped at 25,000 characters by returning fewer list items.
- **Safety**: read-only / write / destructive annotations on every tool; `<PREFIX>_READ_ONLY=1` removes all write tools; `<PREFIX>_DISABLED_TOOLS` removes specific ones; strict schemas reject unknown arguments before any request is made.
- **Security**: credentials only from environment variables; https-only API calls with redirects refused; HTTP mode refuses to listen publicly without authentication; static bearer secret for single-tenant use or OAuth for per-user sign-in, verifying each token's signature, issuer, expiry, and audience and publishing protected-resource metadata; Host/Origin validation; per-caller rate limit; an audit line per tool call with no arguments or data.
- **Docs and checks**: `README.md`, `SECURITY.md` (what is enforced, what to configure, what the team must still review), `.env.example`, and a smoke test.

- **Many accounts**: `<PREFIX>_UPSTREAM_AUTH=token_exchange` makes each API call use a credential for the signed-in user (OAuth token exchange), so one hosted connector can serve many accounts. The server refuses to combine OAuth sign-in with a shared credential unless that is explicitly allowed.
- **Deployment**: a Dockerfile and a CI workflow that builds and audits dependencies.

A generator cannot certify a deployment. Per-user access depends on the platform's authorization server supporting token exchange; where it does not, `src/upstream.ts` in the generated project is the one function to replace.

## Run it

```bash
npm install
npm run build
npm start                      # stdio
TRANSPORT=http npm start       # Streamable HTTP on http://127.0.0.1:3000/mcp
```

Requires Node.js 20.3 or later.

Local MCP host configuration:

```json
{
  "mcpServers": {
    "connector-forge": {
      "command": "node",
      "args": ["/absolute/path/to/connector-forge-mcp-server/dist/index.js"]
    }
  }
}
```

| Variable | Purpose |
|---|---|
| `TRANSPORT` | `http` for Streamable HTTP; otherwise stdio |
| `PORT`, `HOST`, `ALLOWED_HOSTS` | HTTP listen settings. A non-local `HOST` requires `ALLOWED_HOSTS` and `MCP_AUTH_TOKEN` |
| `MCP_AUTH_TOKEN` | Bearer secret (32+ characters) required on `/mcp` when set |
| `FORGE_OUTPUT_DIR` | Where `delivery="write"` saves projects. Default `./connector-forge-output` on stdio; off over HTTP unless set |
| `FORGE_ALLOW_PRIVATE_URLS` | `1` lets `spec_url` reach private addresses and plain http (off by default to prevent the server being used to probe internal networks) |

## Test

```bash
npm run build && npm run smoke            # exercises all four tools
npm run build && npm run smoke -- --e2e   # also builds a generated connector and runs it
```

The `--e2e` run generates a connector from `fixtures/acme-store.yaml`, compiles it, and drives it against a mock API. It also generates a GraphQL connector from `fixtures/shop-demo.graphql` and checks per-user token exchange. It checks requests (paths, query, headers, bodies, auth), error handling, the response cap, read-only mode, fail-closed startup, static-token auth, OAuth (valid token accepted; wrong audience, wrong issuer, and expired tokens refused), and the rate limit.

## Limits

- Input is OpenAPI 3.x or Swagger 2.0 (local `$ref`s), or a GraphQL schema, up to 20 MB. For APIs with neither see `forge_get_guide` topic `no_openapi`.
- GraphQL tools return a default set of fields chosen from the schema (three levels deep); edit the query text in `src/tools/` to change it. Subscriptions are skipped.
- Tested against mock APIs only: the per-user token exchange and the GraphQL connector have not been run against a real authorization server.
- Request bodies: JSON and form-encoded. File uploads and other body types are skipped with a warning.
- Generated tools return the API's JSON. Tool descriptions come from the spec's summaries; rewriting them for the model is the highest-value manual step.
- The spec cache behind `spec_id` is in memory (last 20 specs), per server instance.

## Demo deck

`docs/demo-deck.html` is the 10-slide demo presentation with speaker notes; open it in a browser. It predates GraphQL support and per-user API access, so it does not mention them.
