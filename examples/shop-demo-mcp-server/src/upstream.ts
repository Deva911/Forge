/**
 * Whose permissions API calls use.
 *
 *  SHOP_DEMO_UPSTREAM_AUTH=shared (default): every call uses the one credential in the environment.
 *    Right for local use and for a deployment that serves a single account.
 *  SHOP_DEMO_UPSTREAM_AUTH=token_exchange: each call uses a credential for the signed-in user, obtained from
 *    your authorization server by OAuth token exchange (RFC 8693). Right for one hosted connector that
 *    serves many accounts: nobody can reach data their own account cannot.
 */
import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/server";

export const UPSTREAM_AUTH: "shared" | "token_exchange" = process.env.SHOP_DEMO_UPSTREAM_AUTH === "token_exchange" ? "token_exchange" : "shared";

const TOKEN_ENDPOINT = process.env.OAUTH_TOKEN_ENDPOINT;
const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
/** The audience the exchanged token is for: your API */
const AUDIENCE = process.env.SHOP_DEMO_UPSTREAM_AUDIENCE ?? "https://shop.example/graphql";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Exits when the combination of sign-in mode and credential mode would be unsafe or cannot work. */
export function assertUpstreamAuth(mode: string): void {
  const raw = process.env.SHOP_DEMO_UPSTREAM_AUTH;
  if (raw && raw !== "shared" && raw !== "token_exchange") fail("SHOP_DEMO_UPSTREAM_AUTH must be 'shared' or 'token_exchange'.");

  if (UPSTREAM_AUTH === "token_exchange") {
    if (mode !== "oauth") fail("SHOP_DEMO_UPSTREAM_AUTH=token_exchange needs OAuth sign-in over HTTP (TRANSPORT=http with OAUTH_ISSUER, OAUTH_JWKS_URL, MCP_SERVER_URL).");
    if (!TOKEN_ENDPOINT || !CLIENT_ID || !CLIENT_SECRET) fail("Token exchange needs OAUTH_TOKEN_ENDPOINT, OAUTH_CLIENT_ID, and OAUTH_CLIENT_SECRET.");
    const endpoint = new URL(TOKEN_ENDPOINT);
    if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname)) fail("OAUTH_TOKEN_ENDPOINT must use https.");
    return;
  }
  // Many users signing in while every call uses one credential means every user gets that credential's access.
  if (mode === "oauth" && process.env.SHOP_DEMO_ALLOW_SHARED_CREDENTIAL !== "1") {
    fail(
      "Refusing to start: OAuth sign-in is on, but API calls would all use one shared credential, so every user would get its access. " +
        "Set SHOP_DEMO_UPSTREAM_AUTH=token_exchange for per-user access, or SHOP_DEMO_ALLOW_SHARED_CREDENTIAL=1 if all users really should share it. See SECURITY.md."
    );
  }
}

const cache = new Map<string, { token: string; expiresAt: number }>();

/** Returns an API credential for the signed-in user, exchanging their connector token for one the API accepts. */
export async function userCredential(authInfo: AuthInfo | undefined, signal: AbortSignal): Promise<string> {
  if (!authInfo) throw new Error("Not signed in. Reconnect the connector and sign in again.");
  const key = createHash("sha256").update(authInfo.token).digest("hex");
  const now = Date.now() / 1000;
  const cached = cache.get(key);
  if (cached && cached.expiresAt - 30 > now) return cached.token;

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT as string, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: authInfo.token,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience: AUDIENCE
      }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    });
  } catch {
    throw new Error("Could not reach the sign-in service to authorize this request. Try again shortly.");
  }
  if (!response.ok) throw new Error("Your sign-in does not allow this request, or it has expired. Reconnect the connector and sign in again.");

  const result = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!result.access_token) throw new Error("The sign-in service returned no access token.");
  // Never keep a credential past the life of the sign-in it came from
  const expiresAt = Math.min(now + (result.expires_in ?? 300), authInfo.expiresAt ?? now + 300);
  cache.set(key, { token: result.access_token, expiresAt });
  if (cache.size > 5000) for (const [other, entry] of cache) if (entry.expiresAt <= now) cache.delete(other);
  return result.access_token;
}
