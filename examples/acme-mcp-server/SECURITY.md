# Security of acme-mcp-server

What this connector enforces as generated, what you configure, and what still needs your review. A generator cannot certify a deployment: treat this as the starting point for your own security review.

## Built in

| Control | How it works |
|---|---|
| No secrets in code | API credentials come only from environment variables; the server exits if one is missing. They are never logged or returned in tool results. |
| HTTPS upstream only | The server exits if `ACME_BASE_URL` is not https (localhost excepted, for tests). |
| No redirects | API calls never follow redirects, so credentials cannot be sent to another host. |
| Strict inputs | Every tool validates its arguments against a schema and rejects unknown ones before any request is made. Path values are URL-encoded; `.` and `..` are refused. |
| Fail-closed HTTP | The server refuses to listen on a public interface unless OAuth or a static token is configured. |
| Token audience check | In OAuth mode, tokens are verified for signature, issuer, expiry, and audience; a token issued for another service is refused. |
| DNS-rebinding protection | Host and Origin headers are validated (`ALLOWED_HOSTS`). |
| Rate limit | `RATE_LIMIT_PER_MINUTE` per caller (default 120). |
| Timeouts and size caps | 30-second upstream timeout; responses capped at 25,000 characters. |
| Audit trail | One JSON line per tool call on stderr: tool, caller, success, duration. No arguments or response data. |
| Confirmation hints | Write tools are annotated so MCP clients can ask the user first; destructive ones are marked. |

## You configure

| Variable | Effect |
|---|---|
| `ACME_READ_ONLY=1` | Removes all 4 write tool(s). Recommended for a first launch. |
| `ACME_DISABLED_TOOLS=a,b` | Removes specific tools. Unknown names stop the server from starting. |
| `MCP_AUTH_TOKEN` | Single-tenant HTTP: one shared secret (32+ characters) required as a bearer token. |
| `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `MCP_SERVER_URL`, `OAUTH_REQUIRED_SCOPES` | Multi-user HTTP: per-user sign-in through your authorization server. |
| `ACME_UPSTREAM_AUTH`, `ACME_UPSTREAM_AUDIENCE`, `OAUTH_TOKEN_ENDPOINT`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | Per-user API access by token exchange (see "You must review", item 1). |
| `HOST`, `ALLOWED_HOSTS`, `PORT` | Where the HTTP server listens and which hostnames it answers to. |
| `RATE_LIMIT_PER_MINUTE` | Requests per caller per minute; 0 turns the limiter off. |

Run behind a TLS-terminating proxy or platform; the server itself speaks plain HTTP.

## You must review

1. **Whose permissions do API calls use?** Two modes, set by `ACME_UPSTREAM_AUTH`:
   - `shared` (default): every call uses the one credential in the environment. Right for local use and for a deployment serving a single account. With OAuth sign-in on, the server refuses to start in this mode unless you set `ACME_ALLOW_SHARED_CREDENTIAL=1`, because every signed-in user would get that credential's access.
   - `token_exchange`: each call uses a credential for the signed-in user, obtained from your authorization server by OAuth token exchange (RFC 8693; needs `OAUTH_TOKEN_ENDPOINT`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`). Use this for one hosted connector serving many accounts. Your authorization server must support token exchange; if it does not, replace `userCredential` in `src/upstream.ts` with your own lookup of the user's API credential. Never forward the token the client presented to this server.
2. **Least privilege.** Give the connector's credential only the scopes its tools need. The connector must never be able to do more than the user it acts for.
3. **Write tools.** Review each of: `acme_create_product`, `acme_delete_product`, `acme_update_product`, `acme_create_order_refund`. Remove any that should not be reachable from an AI assistant.
4. **Untrusted content.** Text returned by the API (comments, descriptions, messages written by third parties) can contain instructions aimed at the AI model. Keep destructive tools behind user confirmation, and prefer read-only mode where that risk is high.
5. **Sensitive fields.** Tools return API responses as-is. If responses include personal data or secrets your users should not expose to an assistant, filter those fields in `callOperation` in `src/api.ts`.
6. **Logs.** Send stderr to your log system and alert on spikes in failed calls or 401s.
7. **Dependencies.** Run `npm audit` in CI and keep the MCP SDK current.
8. **Reporting.** Publish a contact for security reports.

Checked against Acme Store API version 2.1.
