import type { ToolDef } from "../api.js";
import { mutationsTools } from "./mutations.js";
import { queriesTools } from "./queries.js";

/** Every tool the server registers. Remove a group or filter this list to expose fewer tools. */
export const allTools: ToolDef[] = [...mutationsTools, ...queriesTools];
