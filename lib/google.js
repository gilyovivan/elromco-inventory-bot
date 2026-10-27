"use strict";
// Service-account access to Search Console and GA4. No Google client library
// is installed and none is needed: a JWT signed with node's own crypto, then
// the ordinary REST endpoints.
//
// GOOGLE_SERVICE_ACCOUNT_JSON holds the whole key file as one string. Railway
// keeps the newlines in the private key, but a key pasted through a shell can
// arrive with them escaped, so both forms are accepted.

const { createSign } = require("crypto");

let parsed = null;
function serviceAccount() {
  if (parsed) return parsed;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  parsed = JSON.parse(raw);
  if (parsed.private_key?.includes("\\n")) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

const b64 = v => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

// One token per scope, reused until it is nearly expired.
const tokens = new Map();

async function accessToken(scope) {
  const cached = tokens.get(scope);
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;

  const key = serviceAccount();
  const iat = Math.floor(Date.now() / 1000);
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) + "." +
    b64({ iss: key.client_email, scope, aud: key.token_uri, iat, exp: iat + 3600 });
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const res = await fetch(key.token_uri, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion:  `${unsigned}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Google refused the token: ${json.error_description || json.error || res.status}`);
  tokens.set(scope, { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 });
  return json.access_token;
}

async function googleApi(url, scope, body) {
  const token = await accessToken(scope);
  const res = await fetch(url, {
    method:  body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${url} returned ${res.status}: ${text.slice(0, 200)}`); }
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json;
}

module.exports = { accessToken, googleApi };
