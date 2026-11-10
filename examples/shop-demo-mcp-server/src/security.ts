/**
 * Safety and security controls for the connector. Everything here is configured
 * by environment variables; SECURITY.md explains each one.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getOAuthProtectedResourceMetadataUrl, requireBearerAuth, type OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ToolDef } from "./api.js";

// ---- Which tools exist ----

/** Applies SHOP_DEMO_READ_ONLY=1 (drop every write tool) and SHOP_DEMO_DISABLED_TOOLS=name,name. */
export function enabledTools(all: ToolDef[]): ToolDef[] {
  const readOnly = process.env.SHOP_DEMO_READ_ONLY === "1";
  const disabled = new Set((process.env.SHOP_DEMO_DISABLED_TOOLS ?? "").split(",").map(name => name.trim()).filter(Boolean));
  const unknown = [...disabled].filter(name => !all.some(tool => tool.name === name));
  if (unknown.length > 0) {
    // A typo here would silently leave a tool enabled, so refuse to start
    console.error(`SHOP_DEMO_DISABLED_TOOLS names unknown tool(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  return all.filter(tool => !disabled.has(tool.name) && (!readOnly || tool.annotations.readOnlyHint));
}

// ---- Audit log ----

/** One JSON line per tool call on stderr. Arguments and responses are never logged: they may hold user data. */
export function auditLog(entry: { tool: string; caller: string; ok: boolean; ms: number }): void {
  console.error(JSON.stringify({ time: new Date().toISOString(), event: "tool_call", ...entry }));
}

// ---- HTTP authentication ----

export interface HttpSecurity {
  mode: "oauth" | "static-token" | "none (localhost only)";
  host: string;
  allowedHosts: string[];
  middleware: RequestHandler[];
  routes: { path: string; handler: RequestHandler }[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Chooses how /mcp is protected:
 *  - OAuth (multi-user): set OAUTH_ISSUER, OAUTH_JWKS_URL, and MCP_SERVER_URL. Access tokens are JWTs
 *    verified for signature, issuer, expiry, and audience (the audience must be MCP_SERVER_URL).
 *  - Static token (single tenant): set MCP_AUTH_TOKEN to a random secret of 32+ characters.
 *  - Neither: only allowed while listening on 127.0.0.1.
 */
export function httpSecurity(): HttpSecurity {
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (host !== "127.0.0.1" && allowedHosts.length === 0) fail("Set ALLOWED_HOSTS (your public hostname) when HOST is not 127.0.0.1.");

  const issuer = process.env.OAUTH_ISSUER;
  const staticToken = process.env.MCP_AUTH_TOKEN;

  if (issuer) {
    const jwksUrl = process.env.OAUTH_JWKS_URL;
    const serverUrlRaw = process.env.MCP_SERVER_URL;
    if (!jwksUrl || !serverUrlRaw) fail("OAuth needs OAUTH_JWKS_URL and MCP_SERVER_URL (the public URL of this server's /mcp endpoint).");
    const serverUrl = new URL(serverUrlRaw);
    const jwks = createRemoteJWKSet(new URL(jwksUrl));
    const requiredScopes = (process.env.OAUTH_REQUIRED_SCOPES ?? "").split(/[ ,]+/).filter(Boolean);

    const verifier: OAuthTokenVerifier = {
      async verifyAccessToken(token): Promise<AuthInfo> {
        try {
          // The audience check means a token issued for some other service is refused here
          const { payload } = await jwtVerify(token, jwks, { issuer, audience: serverUrl.href.replace(/\/$/, "") });
          if (typeof payload.exp !== "number") throw new Error("no expiry");
          const scope = typeof payload.scope === "string" ? payload.scope.split(" ") : Array.isArray(payload.scp) ? (payload.scp as string[]) : [];
          return {
            token,
            clientId: String(payload.client_id ?? payload.azp ?? payload.sub ?? "unknown"),
            scopes: scope,
            expiresAt: payload.exp,
            resource: serverUrl,
            extra: { sub: payload.sub }
          };
        } catch {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
        }
      }
    };

    const metadata = {
      resource: serverUrl.href.replace(/\/$/, ""),
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      ...(requiredScopes.length > 0 ? { scopes_supported: requiredScopes } : {})
    };
    const metadataUrl = getOAuthProtectedResourceMetadataUrl(serverUrl);
    return {
      mode: "oauth",
      host,
      allowedHosts,
      middleware: [requireBearerAuth({ verifier, requiredScopes, expectedResource: serverUrl, resourceMetadataUrl: metadataUrl })],
      // Lets MCP clients discover where users sign in
      routes: [{ path: new URL(metadataUrl).pathname, handler: (_req, res) => void res.json(metadata) }]
    };
  }

  if (staticToken) {
    if (staticToken.length < 32) fail("MCP_AUTH_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32");
    const expected = sha256(staticToken);
    const check: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      // Hash both sides so the comparison is constant-time and length-independent
      if (presented === "" || !timingSafeEqual(sha256(presented), expected)) {
        res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "invalid_token", error_description: "Missing or invalid bearer token" });
        return;
      }
      next();
    };
    return { mode: "static-token", host, allowedHosts, middleware: [check], routes: [] };
  }

  if (host !== "127.0.0.1") {
    fail("Refusing to listen on a public interface without authentication. Configure OAuth (OAUTH_ISSUER, OAUTH_JWKS_URL, MCP_SERVER_URL) or MCP_AUTH_TOKEN. See SECURITY.md.");
  }
  return { mode: "none (localhost only)", host, allowedHosts, middleware: [], routes: [] };
}

// ---- Rate limiting ----

/**
 * Fixed-window limit per caller (token, else IP): RATE_LIMIT_PER_MINUTE, default 120, 0 to turn off.
 * In-memory, so each server instance counts separately; use your gateway's limiter when running several.
 */
export function rateLimit(): RequestHandler {
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120);
  const windows = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (!(limit > 0)) return next();
    const now = Date.now();
    const key = req.headers.authorization ? sha256(req.headers.authorization).toString("hex") : (req.ip ?? "unknown");
    let window = windows.get(key);
    if (!window || now - window.start >= 60_000) {
      window = { start: now, count: 0 };
      windows.set(key, window);
      if (windows.size > 10_000) for (const [other, entry] of windows) if (now - entry.start >= 60_000) windows.delete(other);
    }
    window.count += 1;
    if (window.count > limit) {
      res.status(429).set("Retry-After", String(Math.ceil((window.start + 60_000 - now) / 1000))).json({ error: "rate_limited", error_description: "Too many requests. Retry after the time in the Retry-After header." });
      return;
    }
    next();
  };
}
