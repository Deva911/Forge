import * as z from "zod/v4";
import type { ToolDef } from "../api.js";

export const mutationsTools: ToolDef[] = [
  {
    name: "shop_demo_create_product",
    title: "Create Product",
    description: "Create a product.\n\nRuns the GraphQL mutation 'productCreate' on Shop Demo and returns the JSON response.",
    method: "MUTATION",
    path: "productCreate",
    params: [{ arg: "input", name: "input", in: "query" }],
    graphql: "mutation CreateProduct($input: ProductInput!) { productCreate(input: $input) { id title price status variants { id sku } } }",
    inputSchema: z.strictObject({
      "input": z.looseObject({ "title": z.string(), "price": z.number().optional(), "status": z.enum(["ACTIVE","ARCHIVED"]).optional() }).describe("Input.")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "shop_demo_delete_product",
    title: "Delete Product",
    description: "Delete a product permanently.\n\nRuns the GraphQL mutation 'productDelete' on Shop Demo and returns the JSON response.\n\nThis removes data and may not be reversible; confirm with the user first.",
    method: "MUTATION",
    path: "productDelete",
    params: [{ arg: "id", name: "id", in: "query" }],
    graphql: "mutation DeleteProduct($id: ID!) { productDelete(id: $id) }",
    inputSchema: z.strictObject({
      "id": z.string().describe("Id.")
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }
];
