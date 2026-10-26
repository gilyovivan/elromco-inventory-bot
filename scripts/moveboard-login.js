"use strict";
// One-time MoveBoard sign-in for the bot (OAuth 2.1, PKCE, dynamic client registration).
// Run locally:  node scripts/moveboard-login.js [out-file]
// Opens the browser, waits for the redirect, and writes client_id + refresh_token to out-file
// (default ./moveboard-token.json). Put those two values into Railway as
// MOVEBOARD_CLIENT_ID and MOVEBOARD_REFRESH_TOKEN.
const http   = require("http");
const crypto = require("crypto");
const fs     = require("fs");
const { execFile } = require("child_process");

const ISSUER   = "https://app.elromco.com";
const RESOURCE = "https://app.elromco.com/mcp";
const SCOPE    = "moveboard.read";
const PORT     = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const OUT      = process.argv[2] || "moveboard-token.json";

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  const reg = await fetch(`${ISSUER}/oauth/register`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      client_name:                "Mount Si Analytics Bot",
      redirect_uris:              [REDIRECT],
      grant_types:                ["authorization_code", "refresh_token"],
      response_types:             ["code"],
      token_endpoint_auth_method: "none",
      scope:                      SCOPE,
    }),
  }).then(r => r.json());
  if (!reg.client_id) throw new Error("Client registration failed: " + JSON.stringify(reg));

  const verifier  = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));

  const authUrl = new URL(`${ISSUER}/oauth/authorize`);
  authUrl.search = new URLSearchParams({
    response_type:         "code",
    client_id:             reg.client_id,
    redirect_uri:          REDIRECT,
    scope:                 SCOPE,
    state,
    code_challenge:        challenge,
    code_challenge_method: "S256",
    resource:              RESOURCE,
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const err = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
         .end(err ? `<h2>Error: ${err}</h2>` : "<h2>Done. You can close this tab.</h2>");
      server.close();
      if (err) return reject(new Error(err));
      if (url.searchParams.get("state") !== state) return reject(new Error("state mismatch"));
      resolve(url.searchParams.get("code"));
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log("Opening browser for MoveBoard sign-in...\n" + authUrl.toString());
      execFile("open", [authUrl.toString()], () => {});
    });
  });

  const tokens = await fetch(`${ISSUER}/oauth/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  REDIRECT,
      client_id:     reg.client_id,
      code_verifier: verifier,
      resource:      RESOURCE,
    }),
  }).then(r => r.json());
  if (!tokens.refresh_token) throw new Error("Token exchange failed: " + JSON.stringify(tokens));

  fs.writeFileSync(OUT, JSON.stringify({ client_id: reg.client_id, refresh_token: tokens.refresh_token }, null, 2), { mode: 0o600 });
  console.log(`Saved client_id + refresh_token to ${OUT} (access token expires in ${tokens.expires_in}s, scope: ${tokens.scope}).`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
