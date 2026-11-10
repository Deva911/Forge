import * as z from "zod/v4";
import type { ToolDef } from "../api.js";

export const ordersTools: ToolDef[] = [
  {
    name: "acme_list_orders",
    title: "List orders",
    description: "List orders.\n\nCalls GET /orders on Acme Store API and returns the JSON response.",
    method: "GET",
    path: "/orders",
    params: [{ arg: "customer_email", name: "customerEmail", in: "query" }, { arg: "x_region", name: "X-Region", in: "header" }],
    inputSchema: z.strictObject({
      "customer_email": z.string().describe("Only orders placed by this customer email. Format: email.").optional(),
      "x_region": z.enum(["us","eu"]).describe("Data region to query (sent as a header).").optional()
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "acme_create_order_refund",
    title: "Refund an order",
    description: "Refund an order.\n\nCalls POST /orders/{orderId}/refunds on Acme Store API and returns the JSON response.",
    method: "POST",
    path: "/orders/{orderId}/refunds",
    params: [{ arg: "order_id", name: "orderId", in: "path" }],
    bodyType: "application/json",
    inputSchema: z.strictObject({
      "order_id": z.string().describe("Order Id."),
      body: z.looseObject({ "amount": z.number().min(0.01).describe("Amount to refund in the order currency."), "reason": z.string().nullable().optional() }).describe("Request body.")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }
];
