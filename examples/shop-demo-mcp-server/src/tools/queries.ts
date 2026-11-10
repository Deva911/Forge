import * as z from "zod/v4";
import type { ToolDef } from "../api.js";

export const queriesTools: ToolDef[] = [
  {
    name: "shop_demo_get_product",
    title: "Get Product",
    description: "Look up one product by ID.\n\nRuns the GraphQL query 'product' on Shop Demo and returns the JSON response.",
    method: "QUERY",
    path: "product",
    params: [{ arg: "id", name: "id", in: "query" }],
    graphql: "query GetProduct($id: ID!) { product(id: $id) { id title price status variants { id sku } } }",
    inputSchema: z.strictObject({
      "id": z.string().describe("Id.")
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "shop_demo_list_products",
    title: "List Products",
    description: "List products, newest first.\n\nRuns the GraphQL query 'products' on Shop Demo and returns the JSON response.",
    method: "QUERY",
    path: "products",
    params: [{ arg: "first", name: "first", in: "query" }, { arg: "after", name: "after", in: "query" }, { arg: "query", name: "query", in: "query" }],
    graphql: "query ListProducts($first: Int, $after: String, $query: String) { products(first: $first, after: $after, query: $query) { nodes { id title price status variants { id sku } } pageInfo { hasNextPage endCursor } } }",
    inputSchema: z.strictObject({
      "first": z.number().int().describe("First.").optional(),
      "after": z.string().describe("After.").optional(),
      "query": z.string().describe("Query.").optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "shop_demo_get_shop",
    title: "Get Shop",
    description: "Get Shop.\n\nRuns the GraphQL query 'shop' on Shop Demo and returns the JSON response.",
    method: "QUERY",
    path: "shop",
    params: [],
    graphql: "query GetShop { shop { name currency } }",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }
];
