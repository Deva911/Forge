/**
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
      ...(process.env.SHOP_DEMO_API_KEY ? { SHOP_DEMO_API_KEY: process.env.SHOP_DEMO_API_KEY } : {}),
      ...(process.env.SHOP_DEMO_BASE_URL ? { SHOP_DEMO_BASE_URL: process.env.SHOP_DEMO_BASE_URL } : {})
    }
  })
);

const { tools } = await client.listTools();
assert.equal(tools.length, 5, "unexpected number of tools");
for (const tool of tools) assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
console.error(`Listed ${tools.length} tools`);

const result = await client.callTool({ name: "shop_demo_list_products", arguments: {} });
const first = (result.content as { type: string; text?: string }[])[0];
assert.ok(!result.isError, `shop_demo_list_products failed: ${first?.text}`);
console.error(`shop_demo_list_products OK: ${first?.text?.slice(0, 200)}`);

// Unknown arguments must come back as a tool error the model can read
const invalid = await client.callTool({ name: "shop_demo_list_products", arguments: { not_a_real_argument: 1 } });
assert.equal(invalid.isError, true, "unknown arguments should be rejected");

await client.close();
console.error("Smoke test passed");
