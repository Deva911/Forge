import * as z from "zod/v4";
import type { ToolDef } from "../api.js";

export const productsTools: ToolDef[] = [
  {
    name: "acme_list_products",
    title: "List products",
    description: "List products.\n\nReturns a page of products, newest first.\n\nCalls GET /products on Acme Store API and returns the JSON response.",
    method: "GET",
    path: "/products",
    params: [{ arg: "limit", name: "limit", in: "query" }, { arg: "page_cursor", name: "page[cursor]", in: "query" }, { arg: "status", name: "status", in: "query" }],
    inputSchema: z.strictObject({
      "limit": z.number().int().min(1).max(100).describe("Maximum number of products to return. API default: 20.").optional(),
      "page_cursor": z.string().describe("Cursor from the previous page's next_cursor.").optional(),
      "status": z.enum(["active","archived"]).describe("Filter by status.").optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "acme_create_product",
    title: "Create a product",
    description: "Create a product.\n\nCalls POST /products on Acme Store API and returns the JSON response.",
    method: "POST",
    path: "/products",
    params: [],
    bodyType: "application/json",
    inputSchema: z.strictObject({
      body: z.looseObject({ "name": z.string().max(120).describe("Display name."), "price": z.number().min(0).describe("Unit price."), "tags": z.array(z.string()).optional(), "category": z.looseObject({ "name": z.string().optional(), "parent": z.unknown().optional() }).optional() }).describe("Request body.")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "acme_get_product",
    title: "Get a product",
    description: "Get a product.\n\nCalls GET /products/{productId} on Acme Store API and returns the JSON response.",
    method: "GET",
    path: "/products/{productId}",
    params: [{ arg: "product_id", name: "productId", in: "path" }],
    inputSchema: z.strictObject({
      "product_id": z.string().describe("Product ID, e.g. prod_123.")
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "acme_delete_product",
    title: "Delete a product",
    description: "Delete a product.\n\nCalls DELETE /products/{productId} on Acme Store API and returns the JSON response.\n\nThis removes data and may not be reversible; confirm with the user first.",
    method: "DELETE",
    path: "/products/{productId}",
    params: [{ arg: "product_id", name: "productId", in: "path" }],
    inputSchema: z.strictObject({
      "product_id": z.string().describe("Product ID, e.g. prod_123.")
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "acme_update_product",
    title: "Update a product",
    description: "Update a product.\n\nCalls PATCH /products/{productId} on Acme Store API and returns the JSON response.",
    method: "PATCH",
    path: "/products/{productId}",
    params: [{ arg: "product_id", name: "productId", in: "path" }],
    bodyType: "application/json",
    inputSchema: z.strictObject({
      "product_id": z.string().describe("Product ID, e.g. prod_123."),
      body: z.looseObject({ "name": z.string().max(120).describe("Display name."), "price": z.number().min(0).describe("Unit price."), "tags": z.array(z.string()).optional(), "category": z.looseObject({ "name": z.string().optional(), "parent": z.unknown().optional() }).optional() }).describe("Request body.").optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
];
