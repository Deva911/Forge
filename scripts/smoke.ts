/**
 * Self-check: starts the built server over stdio and exercises every tool.
 *   npm run build && npm run smoke            quick check
 *   npm run build && npm run smoke -- --e2e   also builds the generated connector and runs it against a mock API
 */
import { strict as assert } from "node:assert";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const E2E = process.argv.includes("--e2e");
const outputRoot = mkdtempSync(path.join(tmpdir(), "forge-smoke-"));
const fixture = readFileSync(new URL("../fixtures/acme-store.yaml", import.meta.url), "utf8");

type Result = { isError?: boolean; content?: unknown; structuredContent?: unknown };
const textOf = (result: Result) => (result.content as { text?: string }[])[0]?.text ?? "";

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...getDefaultEnvironment(), FORGE_OUTPUT_DIR: outputRoot } })
);

const { tools } = await client.listTools();
assert.deepEqual(tools.map(tool => tool.name).sort(), ["forge_analyze_api", "forge_generate_connector", "forge_get_guide", "forge_lint_tools"]);

// The forge's own tools should pass its own linter
const self = (await client.callTool({ name: "forge_lint_tools", arguments: { tools, response_format: "json" } })) as Result;
const selfReport = self.structuredContent as { errors: number; warnings: number; score: number; findings: unknown[] };
assert.equal(selfReport.errors, 0, `self-lint errors: ${JSON.stringify(selfReport.findings)}`);
console.error(`Self-lint: ${selfReport.score}/100, ${selfReport.warnings} warnings`);

// Analyze
const analysis = (await client.callTool({ name: "forge_analyze_api", arguments: { spec: fixture, service_name: "Acme", response_format: "json" } })) as Result;
assert.ok(!analysis.isError, textOf(analysis));
const page = analysis.structuredContent as { spec_id: string; total: number; auth: { kind: string }; tools: { tool_name: string }[] };
assert.equal(page.auth.kind, "bearer");
assert.equal(page.total, 7, "deprecated operation should be excluded");
const names = page.tools.map(tool => tool.tool_name);
for (const expected of ["acme_list_products", "acme_create_product", "acme_get_product", "acme_update_product", "acme_delete_product", "acme_list_orders", "acme_create_order_refund"]) {
  assert.ok(names.includes(expected), `missing ${expected} in ${names.join(", ")}`);
}

// Paging, markdown, and filters by spec_id
const paged = (await client.callTool({ name: "forge_analyze_api", arguments: { spec_id: page.spec_id, limit: 2, read_only: true } })) as Result;
assert.match(textOf(paged), /call again with offset=2/);

// Generate inline: small enough to come back whole
const inline = (await client.callTool({
  name: "forge_generate_connector",
  arguments: { spec_id: page.spec_id, service_name: "Acme", include_tags: ["Orders"] }
})) as Result;
assert.ok(!inline.isError, textOf(inline));
const inlineData = inline.structuredContent as { manifest?: { path: string }[]; tools: unknown[]; lint: { errors: number } };
assert.equal(inlineData.tools.length, 2);
assert.equal(inlineData.lint.errors, 0);
// The whole project is larger than one response, so files come in batches by path
assert.ok(textOf(inline).length <= 25_000);
assert.ok(inlineData.manifest?.some(file => file.path === "SECURITY.md"));
const batch = (await client.callTool({
  name: "forge_generate_connector",
  arguments: { spec_id: page.spec_id, service_name: "Acme", include_tags: ["Orders"], paths: ["src/tools/orders.ts", "package.json"] }
})) as Result;
const batchFiles = (batch.structuredContent as { files: { path: string; content: string }[] }).files;
assert.equal(batchFiles.length, 2);
assert.match(batchFiles.find(file => file.path === "src/tools/orders.ts")?.content ?? "", /acme_create_order_refund/);

// Generate to disk
const written = (await client.callTool({ name: "forge_generate_connector", arguments: { spec_id: page.spec_id, service_name: "Acme", delivery: "write" } })) as Result;
assert.ok(!written.isError, textOf(written));
const project = (written.structuredContent as { written_to: string }).written_to;
assert.ok(project.startsWith(outputRoot));

// Errors the model can act on
const again = (await client.callTool({ name: "forge_generate_connector", arguments: { spec_id: page.spec_id, service_name: "Acme", delivery: "write" } })) as Result;
assert.equal(again.isError, true, "writing twice without overwrite should fail");
const tooMany = (await client.callTool({ name: "forge_generate_connector", arguments: { spec_id: page.spec_id, service_name: "Acme", max_tools: 3 } })) as Result;
assert.match(textOf(tooMany), /include_tags/);
const noSource = (await client.callTool({ name: "forge_analyze_api", arguments: {} })) as Result;
assert.equal(noSource.isError, true);
const notSpec = (await client.callTool({ name: "forge_analyze_api", arguments: { spec: '{"hello": "this is not an openapi document"}' } })) as Result;
assert.match(textOf(notSpec), /does not look like an OpenAPI document/);
const privateUrl = (await client.callTool({ name: "forge_analyze_api", arguments: { spec_url: "https://127.0.0.1/openapi.json" } })) as Result;
assert.match(textOf(privateUrl), /private or loopback/);

// Lint a deliberately poor tool list
const lint = (await client.callTool({
  name: "forge_lint_tools",
  arguments: {
    response_format: "json",
    tools: [
      { name: "getUsers", description: "Users" },
      { name: "acme_delete_user", description: "Deletes a user account permanently and returns nothing.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { id: { type: "string" } } } },
      { name: "acme_list_orders", description: "Lists every order in the workspace, newest first, as JSON.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } }
    ]
  }
})) as Result;
const rules = (lint.structuredContent as { findings: { rule: string }[] }).findings.map(finding => finding.rule);
for (const rule of ["name-format", "annotations-readonly", "pagination", "param-descriptions", "description-short"]) assert.ok(rules.includes(rule), `expected ${rule}`);

const guide = (await client.callTool({ name: "forge_get_guide", arguments: { topic: "auth" } })) as Result;
assert.match(textOf(guide), /OAuth/);
// GraphQL input
const sdl = readFileSync(new URL("../fixtures/shop-demo.graphql", import.meta.url), "utf8");
const gqlSource = { graphql_schema: sdl, graphql_endpoint: "https://shop.example/graphql", graphql_auth_header: "X-Shop-Token", service_name: "Shop Demo" };
const gql = (await client.callTool({ name: "forge_analyze_api", arguments: { ...gqlSource, response_format: "json" } })) as Result;
assert.ok(!gql.isError, textOf(gql));
const gqlPage = gql.structuredContent as { tools: { tool_name: string; kind: string }[]; auth: { kind: string; name: string } };
assert.deepEqual(
  gqlPage.tools.map(tool => `${tool.tool_name}:${tool.kind}`),
  ["shop_demo_get_product:read", "shop_demo_list_products:read", "shop_demo_get_shop:read", "shop_demo_create_product:write", "shop_demo_delete_product:write (destructive)"]
);
assert.equal(gqlPage.auth.name, "X-Shop-Token");
const gqlWritten = (await client.callTool({ name: "forge_generate_connector", arguments: { ...gqlSource, delivery: "write" } })) as Result;
assert.ok(!gqlWritten.isError, textOf(gqlWritten));
const gqlProject = (gqlWritten.structuredContent as { written_to: string }).written_to;
await client.close();
console.error("Forge checks passed");

if (E2E) {
  // Build the generated connector, then drive it against a mock Acme API
  const run = (args: string[]) => execFileSync("npm", args, { cwd: project, stdio: ["ignore", "ignore", "inherit"] });
  run(["install", "--no-audit", "--no-fund"]);
  run(["run", "build"]);

  let jwks: unknown = { keys: [] };
  const graphqlSeen: { query: string; variables: Record<string, unknown>; token?: string }[] = [];
  const seen: { method?: string; url?: string; auth?: string; region?: string; body: string }[] = [];
  const mock = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, region: req.headers["x-region"] as string | undefined, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/jwks") return void res.end(JSON.stringify(jwks));
      if (req.url === "/token") return void res.end(JSON.stringify({ access_token: "api-token-for-user-1", expires_in: 60 }));
      if (req.url === "/graphql") {
        const sent = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
        graphqlSeen.push({ ...sent, token: req.headers["x-shop-token"] as string | undefined });
        if (sent.variables.id === "bad") return void res.end(JSON.stringify({ errors: [{ message: "Invalid id" }] }));
        return void res.end(JSON.stringify({ data: { ok: true } }));
      }
      if (req.url?.startsWith("/v2/products/missing")) {
        res.statusCode = 404;
        res.end('{"error":"no such product"}');
      } else if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
      } else if (req.url?.startsWith("/v2/products?")) {
        // Big enough to trigger the response size cap
        res.end(JSON.stringify({ products: Array.from({ length: 400 }, (_, i) => ({ id: `prod_${i}`, name: `Product ${i}`, notes: "x".repeat(150) })), next_cursor: "abc" }));
      } else {
        res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
      }
    });
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v2`;

  const acme = new Client({ name: "e2e", version: "1.0.0" });
  await acme.connect(
    new StdioClientTransport({
      command: "node",
      args: [path.join(project, "dist/index.js")],
      env: { ...getDefaultEnvironment(), ACME_API_TOKEN: "test-token", ACME_BASE_URL: baseUrl }
    })
  );
  const call = async (name: string, args: Record<string, unknown>) => (await acme.callTool({ name, arguments: args })) as Result;
  assert.equal((await acme.listTools()).tools.length, 7);

  const list = await call("acme_list_products", { limit: 5, page_cursor: "c1", status: "active" });
  assert.ok(!list.isError, textOf(list));
  assert.equal(seen.at(-1)?.url, "/v2/products?limit=5&page%5Bcursor%5D=c1&status=active");
  assert.equal(seen.at(-1)?.auth, "Bearer test-token");
  assert.ok(textOf(list).length <= 25_000, "list response should be capped");
  const capped = JSON.parse(textOf(list)) as { products: unknown[]; truncated: { in_response: number }; next_cursor: string };
  assert.ok(capped.products.length < 400 && capped.truncated.in_response === 400 && capped.next_cursor === "abc");

  const created = await call("acme_create_product", { body: { name: "Mug", price: 9.5, tags: ["kitchen"] } });
  assert.deepEqual(JSON.parse(seen.at(-1)?.body ?? "{}"), { name: "Mug", price: 9.5, tags: ["kitchen"] });
  assert.ok(!created.isError);

  await call("acme_list_orders", { customer_email: "a@b.co", x_region: "eu" });
  assert.equal(seen.at(-1)?.url, "/v2/orders?customerEmail=a%40b.co");
  assert.equal(seen.at(-1)?.region, "eu");

  await call("acme_create_order_refund", { order_id: "ord/1", body: { amount: 5 } });
  assert.equal(seen.at(-1)?.url, "/v2/orders/ord%2F1/refunds");

  assert.match(textOf(await call("acme_delete_product", { product_id: "prod_1" })), /HTTP 204/);

  const missing = await call("acme_get_product", { product_id: "missing" });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /Not found.*acme_list_products.*no such product/);

  const invalid = await call("acme_create_product", { body: { name: "No price" } });
  assert.equal(invalid.isError, true, "body missing a required field should be rejected before any request");
  const badEnum = await call("acme_list_products", { status: "nope" });
  assert.equal(badEnum.isError, true);

  const dots = await call("acme_get_product", { product_id: ".." });
  assert.match(textOf(dots), /not a valid value/);
  await acme.close();

  // ---- Safety switches ----
  const baseEnv = { ...getDefaultEnvironment(), ACME_API_TOKEN: "test-token", ACME_BASE_URL: baseUrl };
  const entry = path.join(project, "dist/index.js");
  const readOnly = new Client({ name: "e2e-ro", version: "1.0.0" });
  await readOnly.connect(new StdioClientTransport({ command: "node", args: [entry], env: { ...baseEnv, ACME_READ_ONLY: "1", ACME_DISABLED_TOOLS: "acme_list_orders" } }));
  assert.deepEqual((await readOnly.listTools()).tools.map(tool => tool.name).sort(), ["acme_get_product", "acme_list_products"]);
  await readOnly.close();

  const exits = (env: Record<string, string>) => spawnSync("node", [entry], { env: { ...baseEnv, ...env }, encoding: "utf8", timeout: 10_000 });
  assert.match(exits({ ACME_BASE_URL: "http://api.acme-store.example/v2" }).stderr, /must use https/);
  assert.match(exits({ ACME_API_TOKEN: "" }).stderr, /Missing required environment variable/);
  assert.match(exits({ ACME_DISABLED_TOOLS: "acme_typo" }).stderr, /unknown tool/);
  assert.match(exits({ TRANSPORT: "http", HOST: "0.0.0.0", ALLOWED_HOSTS: "mcp.acme.example" }).stderr, /without authentication/);
  assert.match(exits({ TRANSPORT: "http", MCP_AUTH_TOKEN: "short" }).stderr, /at least 32 characters/);

  // ---- HTTP authentication ----
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1.0.0" } } };
  const post = (port: number, token?: string) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(initialize)
    });
  const serve = async (port: number, env: Record<string, string>) => {
    const child = spawn("node", [entry], { env: { ...baseEnv, TRANSPORT: "http", PORT: String(port), ...env }, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => chunk.toString().includes("listening") && resolve());
      child.on("exit", code => reject(new Error(`server exited with ${code}`)));
    });
    return child;
  };

  const secret = "s".repeat(40);
  const staticServer = await serve(39211, { MCP_AUTH_TOKEN: secret, RATE_LIMIT_PER_MINUTE: "3" });
  assert.equal((await post(39211)).status, 401, "no token");
  assert.equal((await post(39211, "wrong-token")).status, 401, "wrong token");
  assert.equal((await post(39211, secret)).status, 200, "right token");
  await post(39211, secret);
  await post(39211, secret);
  assert.equal((await post(39211, secret)).status, 429, "rate limit after 3 requests");
  staticServer.kill();

  // OAuth: tokens signed by a test issuer whose keys the mock server publishes
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  const issuer = "https://auth.acme.example";
  const serverUrl = "https://mcp.acme.example/mcp";
  const mint = (audience: string, expires: string, iss = issuer) =>
    new SignJWT({ scope: "acme.read", client_id: "client-1" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(iss).setAudience(audience).setSubject("user-1").setExpirationTime(expires).sign(privateKey);
  const oauthServer = await serve(39212, { OAUTH_ISSUER: issuer, OAUTH_JWKS_URL: `${baseUrl.replace("/v2", "")}/jwks`, MCP_SERVER_URL: serverUrl, OAUTH_REQUIRED_SCOPES: "acme.read", ACME_ALLOW_SHARED_CREDENTIAL: "1" });
  const challenge = await post(39212);
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate") ?? "", /resource_metadata/);
  const metadata = (await (await fetch("http://127.0.0.1:39212/.well-known/oauth-protected-resource/mcp")).json()) as { authorization_servers: string[] };
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.equal((await post(39212, await mint(serverUrl, "5m"))).status, 200, "valid token");
  assert.equal((await post(39212, await mint("https://other-service.example", "5m"))).status, 401, "token for another audience");
  assert.equal((await post(39212, await mint(serverUrl, "-5m"))).status, 401, "expired token");
  assert.equal((await post(39212, await mint(serverUrl, "5m", "https://evil.example"))).status, 401, "wrong issuer");
  oauthServer.kill();

  // Per-user API access: OAuth sign-in plus a shared credential must be an explicit choice
  const oauthEnv = { TRANSPORT: "http", OAUTH_ISSUER: issuer, OAUTH_JWKS_URL: `${baseUrl.replace("/v2", "")}/jwks`, MCP_SERVER_URL: serverUrl };
  assert.match(exits(oauthEnv).stderr, /one shared credential/);
  assert.match(exits({ ACME_UPSTREAM_AUTH: "token_exchange" }).stderr, /needs OAuth sign-in/);
  const exchangeServer = await serve(39213, {
    ...oauthEnv,
    ACME_API_TOKEN: "",
    ACME_UPSTREAM_AUTH: "token_exchange",
    OAUTH_TOKEN_ENDPOINT: `${baseUrl.replace("/v2", "")}/token`,
    OAUTH_CLIENT_ID: "connector",
    OAUTH_CLIENT_SECRET: "connector-secret"
  });
  const userClient = new Client({ name: "e2e-user", version: "1.0.0" });
  await userClient.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:39213/mcp"), { requestInit: { headers: { Authorization: `Bearer ${await mint(serverUrl, "5m")}` } } })
  );
  const asUser = (await userClient.callTool({ name: "acme_get_product", arguments: { product_id: "prod_1" } })) as Result;
  assert.ok(!asUser.isError, textOf(asUser));
  assert.equal(seen.at(-1)?.auth, "Bearer api-token-for-user-1", "the API must be called with the user's own credential");
  await userClient.close();
  exchangeServer.kill();

  // ---- GraphQL connector ----
  symlinkSync(path.join(project, "node_modules"), path.join(gqlProject, "node_modules"));
  execFileSync("npm", ["run", "build"], { cwd: gqlProject, stdio: ["ignore", "ignore", "inherit"] });
  const shop = new Client({ name: "e2e-gql", version: "1.0.0" });
  await shop.connect(
    new StdioClientTransport({
      command: "node",
      args: [path.join(gqlProject, "dist/index.js")],
      env: { ...getDefaultEnvironment(), SHOP_DEMO_API_KEY: "shop-key", SHOP_DEMO_BASE_URL: `${baseUrl.replace("/v2", "")}/graphql` }
    })
  );
  const listed = (await shop.callTool({ name: "shop_demo_list_products", arguments: { first: 5, query: "mug" } })) as Result;
  assert.ok(!listed.isError, textOf(listed));
  assert.equal(graphqlSeen.at(-1)?.token, "shop-key");
  assert.deepEqual(graphqlSeen.at(-1)?.variables, { first: 5, query: "mug" });
  assert.match(graphqlSeen.at(-1)?.query ?? "", /^query ListProducts\(\$first: Int, \$after: String, \$query: String\) \{ products\(first: \$first, after: \$after, query: \$query\) \{ nodes \{ id title price status variants \{ id sku \} \} pageInfo \{ hasNextPage endCursor \} \} \}$/);
  await shop.callTool({ name: "shop_demo_create_product", arguments: { input: { title: "Mug", price: 9.5, status: "ACTIVE" } } });
  assert.deepEqual(graphqlSeen.at(-1)?.variables, { input: { title: "Mug", price: 9.5, status: "ACTIVE" } });
  const rejected = (await shop.callTool({ name: "shop_demo_get_product", arguments: { id: "bad" } })) as Result;
  assert.match(textOf(rejected), /rejected the request: Invalid id/);
  const badInput = (await shop.callTool({ name: "shop_demo_create_product", arguments: { input: { price: 1 } } })) as Result;
  assert.equal(badInput.isError, true, "input missing a required field is rejected before any request");
  await shop.close();
  console.error("GraphQL and per-user access checks passed");
  console.error("Security checks passed (fail-closed startup, static token, OAuth audience/expiry/issuer, rate limit, read-only mode)");

  // The generated project's own self-check must pass too
  // Async, because the mock API lives in this process and must keep answering
  await promisify(execFile)("npm", ["run", "smoke"], { cwd: project, env: { ...process.env, ACME_API_TOKEN: "test-token", ACME_BASE_URL: baseUrl } });
  mock.close();
  console.error("End-to-end checks passed (generated connector built, ran, and called the mock API)");
}
console.error("Smoke test passed");
