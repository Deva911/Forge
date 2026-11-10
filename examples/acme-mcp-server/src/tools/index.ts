import type { ToolDef } from "../api.js";
import { ordersTools } from "./orders.js";
import { productsTools } from "./products.js";

/** Every tool the server registers. Remove a group or filter this list to expose fewer tools. */
export const allTools: ToolDef[] = [...ordersTools, ...productsTools];
