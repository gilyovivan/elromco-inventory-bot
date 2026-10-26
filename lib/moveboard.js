"use strict";
// MoveBoard MCP client: keeps an OAuth access token fresh and calls read tools.
const fs = require("fs");
const path = require("path");

const ISSUER       = "https://app.elromco.com";
const MCP_URL      = "https://app.elromco.com/mcp";
const CLIENT_ID    = process.env.MOVEBOARD_CLIENT_ID || "";
// The refresh token may rotate on every refresh, so the newest one is kept on the volume.
const TOKEN_FILE   = process.env.MOVEBOARD_TOKEN_FILE || "/data/moveboard-token.json";

let accessToken = null;
let accessExpiresAt = 0;
let sessionId = null;
let rpcId = 0;

function loadRefreshToken() {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (saved.refresh_token) return saved.refresh_token;
  } catch {}
  return process.env.MOVEBOARD_REFRESH_TOKEN || "";
}

function saveRefreshToken(refreshToken) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: refreshToken, saved_at: new Date().toISOString() }), { mode: 0o600 });
  } catch (e) {
    console.error("Could not save refresh token:", e.message);
  }
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessExpiresAt - 60_000) return accessToken;

  const refreshToken = loadRefreshToken();
  if (!CLIENT_ID || !refreshToken) throw new Error("MOVEBOARD_CLIENT_ID / MOVEBOARD_REFRESH_TOKEN are not set");

  const res = await fetch(`${ISSUER}/oauth/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     CLIENT_ID,
      resource:      MCP_URL,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`MoveBoard token refresh failed (${res.status}): ${data.error_description || data.error || "unknown"}`);

  accessToken     = data.access_token;
  accessExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  if (data.refresh_token && data.refresh_token !== refreshToken) saveRefreshToken(data.refresh_token);
  sessionId = null;
  return accessToken;
}

// Streamable HTTP: the reply is either plain JSON or an SSE stream with one JSON-RPC message.
async function parseRpcResponse(res) {
  const type = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!type.includes("text/event-stream")) return text ? JSON.parse(text) : null;
  const messages = text.split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(Boolean)
    .map(json => JSON.parse(json));
  return messages.find(m => m.id !== undefined) || messages[messages.length - 1] || null;
}

async function rpc(method, params, { notification = false } = {}) {
  const token = await getAccessToken();
  const headers = {
    "Content-Type":  "application/json",
    "Accept":        "application/json, text/event-stream",
    "Authorization": `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const body = { jsonrpc: "2.0", method, params };
  if (!notification) body.id = ++rpcId;

  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.headers.get("mcp-session-id")) sessionId = res.headers.get("mcp-session-id");
  if (res.status === 401) { accessToken = null; throw new Error("MoveBoard rejected the access token (401)"); }
  if (notification) return null;
  if (!res.ok) throw new Error(`MoveBoard MCP ${method}: HTTP ${res.status}`);

  const msg = await parseRpcResponse(res);
  if (msg?.error) throw new Error(`MoveBoard MCP ${method}: ${msg.error.message}`);
  return msg?.result;
}

async function ensureSession() {
  if (sessionId && accessToken && Date.now() < accessExpiresAt - 60_000) return;
  await getAccessToken();
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities:    {},
    clientInfo:      { name: "mount-si-analytics-bot", version: "3.0.0" },
  });
  await rpc("notifications/initialized", {}, { notification: true });
}

// Calls one tool and returns its parsed JSON answer (or the raw text when it isn't JSON).
async function callTool(name, args = {}) {
  await ensureSession();
  const result = await rpc("tools/call", { name, arguments: args });
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  if (result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

module.exports = { callTool, getAccessToken, MCP_URL };
