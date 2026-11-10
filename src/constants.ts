export const SERVER_NAME = "connector-forge-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Tool responses stay under this many characters */
export const CHARACTER_LIMIT = 25_000;
/** A single explicitly requested generated file may be this large */
export const SINGLE_FILE_LIMIT = 200_000;
export const MAX_SPEC_BYTES = 20_000_000;
export const SPEC_CACHE_SIZE = 20;
/** Above this many tools, a connector costs the model noticeable context */
export const RECOMMENDED_MAX_TOOLS = 40;
