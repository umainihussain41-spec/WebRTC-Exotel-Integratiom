/**
 * Exotel "Web Browser Calling" sample server
 * ------------------------------------------
 * Serves the dialer website AND acts as a small secure backend so the browser
 * never holds the Exotel secrets.
 *
 * Verified Exotel facts baked into this server:
 *   - Token API body is  { Id, Secret, Entity }  where Entity is "customer" or "app".
 *   - Your Client ID IS the CustomerID; the App has its own Id/Secret.
 *   - The WebSDK access token must be an APP token.
 *   - The Voice API Key/Token you were given were labelled swapped (fixed in .env).
 *   - Recording is an APP setting (record=true), not a per-call parameter.
 *   - Voice v1 auth must be an Authorization: Basic header. Node's fetch()
 *     throws on https://key:token@host URLs, so the old form silently broke.
 *
 * Endpoints
 *   GET  /api/config              -> public, non-secret settings for the frontend
 *   POST /api/webrtc/token        -> APP access token for the WebSDK (+ userId)
 *   GET  /api/webrtc/whoami       -> which Exotel App/account the token resolves to
 *   GET  /api/webrtc/user         -> look up a WebRTC user mapping by email
 *   POST /api/provision/app       -> register the App under the customer
 *   POST /api/provision/user      -> create a WebRTC user (agent) — both in & out
 *   POST /api/provision/setting   -> set an App setting (Key/Value)
 *   GET  /api/provision/status    -> app + user provisioning status at a glance
 *   GET  /api/call/:sid           -> Get call details (Voice v1)
 *   POST /webhook/call-status     -> Receives Exotel status callbacks (logged)
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
// Railway (and any other PaaS) terminates TLS at a proxy. Without this Express
// reports req.protocol as "http" and the session cookie never gets Secure set.
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const cfg = {
  accountSid: process.env.EXOTEL_ACCOUNT_SID || "",
  subdomain: process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com",
  apiKey: process.env.EXOTEL_API_KEY || "",
  apiToken: process.env.EXOTEL_API_TOKEN || "",
  callerId: process.env.EXOTEL_CALLER_ID || "",
  region: process.env.EXOTEL_REGION || "Mumbai",
  exotelDomain: process.env.EXOTEL_EXOTEL_DOMAIN || "mumbai",
  icoreBase: process.env.EXOTEL_ICORE_BASE || "https://integrationscore.mum1.exotel.com",
  clientId: process.env.EXOTEL_CLIENT_ID || "",
  clientSecret: process.env.EXOTEL_CLIENT_SECRET || "",
  appName: process.env.EXOTEL_APP_NAME || "webdialer",
  appId: process.env.EXOTEL_APP_ID || "",
  appSecret: process.env.EXOTEL_APP_SECRET || "",
  webrtcUserId: process.env.EXOTEL_WEBRTC_USER_ID || "",
  agentName: process.env.EXOTEL_AGENT_NAME || "",
  agentNumber: process.env.EXOTEL_AGENT_NUMBER || "",
  port: process.env.PORT || 3000,
};

// ---- Access gate ----------------------------------------------------------
// This matters the moment the app leaves localhost. /api/webrtc/token mints an
// Exotel APP token, and anyone holding one can place calls billed to this
// account and read the agent's SIP credentials. So when APP_PASSWORD is set
// (always do this in production) every page and API call needs a session.

const AUTH_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = "exo_session";

// Paths that must stay reachable without a session.
const OPEN_PATHS = new Set(["/login", "/logout", "/login.html", "/styles.css", "/healthz"]);

const sign = (v) => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex");

function issueToken() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function tokenValid(tok) {
  if (!tok) return false;
  const [exp, sig] = String(tok).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1));
    }
  }
  return null;
}

// Constant-time password compare that doesn't leak length via early return.
function passwordMatches(supplied) {
  const a = crypto.createHash("sha256").update(String(supplied || "")).digest();
  const b = crypto.createHash("sha256").update(AUTH_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Crude but effective brute-force brake: per-IP backoff on failed logins.
const loginFails = new Map();
function throttled(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (Date.now() > rec.until) { loginFails.delete(ip); return 0; }
  return Math.ceil((rec.until - Date.now()) / 1000);
}
function noteFailure(ip) {
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  // 5 free attempts, then escalate: 5s, 10s, 20s … capped at 5 minutes.
  if (rec.count > 5) {
    rec.until = Date.now() + Math.min(300000, 5000 * Math.pow(2, rec.count - 6));
  }
  loginFails.set(ip, rec);
}

app.post("/login", (req, res) => {
  if (!AUTH_PASSWORD) return res.json({ ok: true, open: true });
  const wait = throttled(req.ip);
  if (wait) {
    return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${wait}s.` });
  }
  if (!passwordMatches(req.body && req.body.password)) {
    noteFailure(req.ip);
    return res.status(401).json({ ok: false, error: "Incorrect password." });
  }
  loginFails.delete(req.ip);
  res.cookie(COOKIE, issueToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.protocol === "https",
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.post("/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  if (!AUTH_PASSWORD) return next();                 // local dev: wide open
  if (req.path.startsWith("/webhook/")) return next(); // Exotel posts here
  if (OPEN_PATHS.has(req.path)) return next();
  if (tokenValid(readCookie(req, COOKIE))) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Not signed in." });
  }
  res.redirect("/login.html");
});

// ---- Exotel helpers -------------------------------------------------------

// Create an integrations token. entity = "customer" | "app".
async function createToken(entity, id, secret) {
  const res = await fetch(`${cfg.icoreBase}/v2/integrations/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Id: id, Secret: secret, Entity: entity }),
  });
  const body = await res.json();
  if (body && body.Status === "Success" && body.Data) return body.Data;
  const msg = (body && body.Error) || `token request failed (HTTP ${res.status})`;
  throw new Error(msg);
}

const customerToken = () => createToken("customer", cfg.clientId, cfg.clientSecret);
const appToken = () => createToken("app", cfg.appId, cfg.appSecret);

// Base URL for the classic Voice v1 API.
// NOTE: credentials go in an Authorization header, NOT in the URL — Node's
// fetch() refuses to build a Request from a URL that embeds user:password.
function voiceBaseUrl() {
  return `https://${cfg.subdomain}/v1/Accounts/${cfg.accountSid}`;
}

function voiceAuthHeader() {
  return "Basic " + Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString("base64");
}

// Never let a secret ride out inside an error string.
function scrubSecrets(input) {
  let out = String(input && input.message ? input.message : input);
  for (const secret of [cfg.apiKey, cfg.apiToken, cfg.clientSecret, cfg.appSecret]) {
    if (secret) out = out.split(secret).join("***redacted***");
  }
  return out;
}

// The user-mapping response carries the agent's SIP password. Never let that
// reach the browser — the WebSDK derives it itself from the app token.
function redactUser(data) {
  if (!data || typeof data !== "object") return data;
  const clone = JSON.parse(JSON.stringify(data));
  const scrub = (o) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (/secret/i.test(k)) o[k] = "***redacted***";
      else if (typeof o[k] === "object") scrub(o[k]);
    }
  };
  scrub(clone);
  return clone;
}

// Non-secret summary of an agent's WebRTC provisioning, safe for the frontend.
function userSummary(d) {
  return {
    provisioned: true,
    userId: d.AppUserId || cfg.webrtcUserId,
    name: d.ExotelUserName || d.AppUsername || "",
    virtualNumber: d.VirtualNumber || "",
    sipDeviceId: d.SipDeviceID || d.ActiveDeviceId || "",
    outboundActive: Boolean(d.OutboundActive),
    isActive: Boolean(d.IsActive),
  };
}

// JWT 'exp' (seconds) -> ISO string, so the frontend can warn before it lapses.
function tokenExpiry(jwt) {
  try {
    const p = JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64").toString());
    return p.exp ? new Date(p.exp * 1000).toISOString() : null;
  } catch (e) {
    return null;
  }
}

// ---- config ---------------------------------------------------------------

app.get("/api/config", (req, res) => {
  res.json({
    accountSid: cfg.accountSid,
    region: cfg.region,
    callerId: cfg.callerId,
    webrtcUserId: cfg.webrtcUserId,
    hasVoiceApi: Boolean(cfg.apiKey && cfg.apiToken && cfg.callerId),
    hasWebrtc: Boolean(cfg.appId && cfg.appSecret),
  });
});

// ---- WebSDK access token (APP token) --------------------------------------

app.post("/api/webrtc/token", async (req, res) => {
  if (!cfg.appId || !cfg.appSecret) {
    return res.status(400).json({
      ok: false,
      error: "App not provisioned yet. Run: npm run provision (sets EXOTEL_APP_ID/SECRET).",
    });
  }
  try {
    const token = await appToken();
    res.json({ ok: true, accessToken: token, userId: cfg.webrtcUserId, expiresAt: tokenExpiry(token) });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

app.get("/api/webrtc/whoami", async (req, res) => {
  try {
    const token = await appToken();
    const r = await fetch(`${cfg.icoreBase}/v2/integrations/app`, { headers: { Authorization: token } });
    const app = await r.json();
    res.json({ ok: r.ok, httpStatus: r.status, app });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

app.get("/api/webrtc/user", async (req, res) => {
  const userId = req.query.user_id || cfg.webrtcUserId;
  if (!userId) return res.status(400).json({ ok: false, error: "Provide ?user_id=email" });
  try {
    const token = await appToken();
    const r = await fetch(
      `${cfg.icoreBase}/v2/integrations/usermapping?user_id=${encodeURIComponent(userId)}`,
      { headers: { Authorization: token, "Content-Type": "application/json" } }
    );
    const data = await r.json();
    res.json({ ok: r.ok, httpStatus: r.status, user: redactUser(data) });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

// ---- Provisioning ---------------------------------------------------------

// Register the App under the customer. Returns AppID + AppSecret.
app.post("/api/provision/app", async (req, res) => {
  try {
    const token = await customerToken();
    const payload = {
      AppName: (req.body && req.body.appName) || cfg.appName,
      ExotelAccountSid: cfg.accountSid,
      ExotelApiKey: cfg.apiKey,
      ExotelApiToken: cfg.apiToken,
      ExotelDomain: cfg.exotelDomain,
      IsActive: true,
    };
    const r = await fetch(`${cfg.icoreBase}/v2/integrations/app`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok && data.Status === "Success", data });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

// Create a WebRTC user (agent). This enables BOTH incoming and outgoing.
app.post("/api/provision/user", async (req, res) => {
  const email = (req.body && req.body.email) || cfg.webrtcUserId;
  const name = (req.body && req.body.name) || cfg.agentName || email;
  const virtualNumber = (req.body && req.body.virtualNumber) || cfg.callerId;
  const agentNumber = (req.body && req.body.agentNumber) || cfg.agentNumber;
  if (!email) return res.status(400).json({ ok: false, error: "email (agent user id) is required" });
  try {
    const token = await appToken();
    const entry = {
      AppUserId: email,
      AppUsername: name,
      Email: email,
      ExotelAccountSid: cfg.accountSid,
      ExotelUserName: name,
      VirtualNumber: virtualNumber,
    };
    if (agentNumber) entry.AgentNumber = agentNumber;
    const r = await fetch(`${cfg.icoreBase}/v2/integrations/usermapping`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify([entry]),
    });
    const data = await r.json();
    const trial = data && /trial account/i.test(data.Error || "");
    res.status(r.ok ? 200 : r.status).json({
      ok: r.ok && data.Status === "Success",
      trialBlocked: Boolean(trial),
      hint: trial ? "Account is on trial. Ask Exotel to upgrade/enable WebRTC user creation." : undefined,
      data,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

// Set an App setting (Key/Value): e.g. record, callback, incomingCallHangup, popup.
app.post("/api/provision/setting", async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: "key is required" });
  try {
    const token = await appToken();
    const r = await fetch(`${cfg.icoreBase}/v2/integrations/app_setting`, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ Key: key, Value: String(value) }),
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

// One-glance provisioning status.
app.get("/api/provision/status", async (req, res) => {
  const out = { app: null, user: null, appConfigured: Boolean(cfg.appId && cfg.appSecret) };
  try {
    if (out.appConfigured) {
      const token = await appToken();
      const ar = await fetch(`${cfg.icoreBase}/v2/integrations/app`, { headers: { Authorization: token } });
      const aj = await ar.json();
      out.app = aj.Data || null;
      if (cfg.webrtcUserId) {
        const ur = await fetch(
          `${cfg.icoreBase}/v2/integrations/usermapping?user_id=${encodeURIComponent(cfg.webrtcUserId)}`,
          { headers: { Authorization: token, "Content-Type": "application/json" } }
        );
        const uj = await ur.json();
        out.user =
          ur.ok && uj.Data ? userSummary(uj.Data) : { provisioned: false, userId: cfg.webrtcUserId };
      }
    }
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err), ...out });
  }
});

// Account health: Type (Trial/Full), Status, BillingType, KycStatus. Useful
// because Exotel refuses calls with a bare 402 when a prepaid account runs dry.
app.get("/api/account", async (req, res) => {
  try {
    const r = await fetch(`${voiceBaseUrl()}.json`, {
      headers: { Authorization: voiceAuthHeader() },
    });
    const data = await r.json();
    const a = (data && data.Account) || {};
    res.status(r.ok ? 200 : r.status).json({
      ok: r.ok,
      account: {
        sid: a.Sid,
        name: a.FriendlyName,
        type: a.Type,
        status: a.Status,
        billingType: a.BillingType,
        kycStatus: a.KycStatus,
      },
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

// ---- Call details (Voice v1) ----------------------------------------------

app.get("/api/call/:sid", async (req, res) => {
  try {
    const r = await fetch(`${voiceBaseUrl()}/Calls/${encodeURIComponent(req.params.sid)}.json`, {
      headers: { Authorization: voiceAuthHeader() },
    });
    const data = await r.json();
    res.status(r.ok ? 200 : r.status).json({ ok: r.ok, data });
  } catch (err) {
    res.status(502).json({ ok: false, error: scrubSecrets(err) });
  }
});

app.post("/webhook/call-status", (req, res) => {
  console.log("[webhook/call-status]", JSON.stringify(req.body));
  res.sendStatus(200);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(cfg.port, () => {
  console.log(`\n  Exotel Web Browser Calling running:  http://localhost:${cfg.port}\n`);
  if (AUTH_PASSWORD) {
    console.log("  Access gate: ON (APP_PASSWORD set).\n");
    if (!process.env.SESSION_SECRET) {
      console.log("  NOTE: SESSION_SECRET not set — sessions drop on every restart.\n");
    }
  } else {
    console.log(
      "  WARNING: no APP_PASSWORD set — anyone who can reach this URL can place\n" +
      "           calls billed to your Exotel account. Fine on localhost; set\n" +
      "           APP_PASSWORD before deploying anywhere public.\n"
    );
  }
  if (!cfg.appId) {
    console.log("  NOTE: App not provisioned. Run:  npm run provision\n");
  } else if (!cfg.webrtcUserId) {
    console.log("  NOTE: No WebRTC agent set. Set EXOTEL_WEBRTC_USER_ID and run: npm run provision\n");
  }
});
