#!/usr/bin/env node
/**
 * Builds the standalone credential generator that customers run themselves.
 *
 *   node scripts/make-generator.js
 *
 * Output: out/exotel-credential-generator.html
 *
 * The customer opens that file locally, enters their Account SID and the
 * administrator email on their Exotel account, and receives their Client ID and
 * Client Secret. No server is involved: the page calls Exotel directly from the
 * browser, which the endpoint permits (it returns Access-Control-Allow-Origin *).
 *
 * The endpoint is written into the generated file, so the file is built here
 * from .env rather than committed. Anyone you send it to can read the endpoint
 * out of it, which is the unavoidable cost of letting the customer generate
 * without a server standing in between.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const BASE = process.env.CRED_UPSTREAM_BASE;
const UPATH = process.env.CRED_UPSTREAM_PATH;
const OUT = path.join(__dirname, "..", "out", "exotel-credential-generator.html");

if (!BASE || !UPATH) {
  console.error("\n  Set CRED_UPSTREAM_BASE and CRED_UPSTREAM_PATH in .env first.\n");
  process.exit(1);
}
const URL = BASE.replace(/\/+$/, "") + "/" + UPATH.replace(/^\/+/, "");

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<meta name="referrer" content="no-referrer" />
<title>Exotel WebRTC credentials</title>
<style>
:root{
  --navy:#1e3a5f; --green:#0f9d7a; --red:#d1494b;
  --bg:#f4f6f9; --surface:#fff; --surface-2:#f7f9fb;
  --border:#e3e7ed; --border-strong:#ccd3dd;
  --text:#1c2434; --text-soft:#59636f; --text-faint:#8a94a1;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --font:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.5}
.wrap{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px 64px}
.card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);
      border-radius:8px;box-shadow:0 1px 2px rgba(28,36,52,.06),0 4px 12px rgba(28,36,52,.07);overflow:hidden}
.band{background:var(--navy);color:#fff;padding:14px 18px}
.band .b{font-size:.72rem;font-weight:600;letter-spacing:.18em;text-transform:uppercase}
.band .s{font-size:.7rem;color:rgba(255,255,255,.65)}
.body{padding:20px 18px}
h1{margin:0 0 6px;font-size:1.06rem;font-weight:700}
.sub{margin:0 0 18px;font-size:.84rem;color:var(--text-soft)}
label{display:block;margin-bottom:14px}
label span{display:block;font-size:.72rem;font-weight:700;color:var(--text-soft);margin-bottom:5px}
input{width:100%;height:40px;padding:0 11px;border:1px solid var(--border-strong);border-radius:4px;
      background:var(--surface);font-family:var(--mono);font-size:.9rem;color:var(--text);outline:none}
input:focus{border-color:var(--green);box-shadow:0 0 0 2px rgba(15,157,122,.15)}
.hint{font-size:.72rem;color:var(--text-faint);margin-top:4px;font-family:var(--font)}
button.go{width:100%;height:40px;border:0;border-radius:4px;background:var(--green);color:#fff;
          font:inherit;font-size:.88rem;font-weight:600;cursor:pointer}
button.go:hover{filter:brightness(1.05)}
button.go:disabled{opacity:.5;cursor:not-allowed}
.msg{margin:12px 0 0;font-size:.8rem;min-height:1em;color:var(--red)}
.warn{display:flex;gap:9px;background:#fdf6e8;border:1px solid #f0e2c6;border-radius:4px;
      padding:10px 12px;margin:0 0 16px;font-size:.78rem;color:#7a5510}
.cred{border:1px solid var(--border-strong);border-radius:4px;background:var(--surface-2);padding:11px 12px;margin-bottom:10px}
.cred .l{font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-faint);margin-bottom:5px}
.cred .r{display:flex;gap:8px;align-items:center}
.cred .v{flex:1;font-family:var(--mono);font-size:.82rem;word-break:break-all;line-height:1.45}
.copy{flex:none;border:1px solid var(--border-strong);background:var(--surface);color:var(--text-soft);
      font:inherit;font-size:.68rem;font-weight:600;padding:4px 10px;border-radius:3px;cursor:pointer}
.copy.done{background:var(--green);border-color:var(--green);color:#fff}
.foot{margin:16px 0 0;padding-top:12px;border-top:1px solid var(--border);font-size:.75rem;color:var(--text-faint)}
.foot code{font-family:var(--mono);font-size:.72rem}
.blocked{border-left:3px solid var(--red);background:#fcefef;padding:12px 14px;font-size:.82rem;color:#8e2f31}
.blocked b{display:block;margin-bottom:4px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="band">
      <div class="b">Exotel</div>
      <div class="s">WebRTC credentials</div>
    </div>
    <div class="body">

      <div id="blockedView" hidden>
        <div class="blocked">
          <b>Credentials have already been generated</b>
          <span id="blockedText"></span>
        </div>
        <p class="foot">
          Credentials are issued once per account. If you no longer have them, or
          you need them reissued, email <code>hello@exotel.in</code> quoting your
          Account SID. Section 5.3 of your integration guide has a template.
        </p>
      </div>

      <div id="formView">
        <h1>Generate your credentials</h1>
        <p class="sub">
          This produces the Client ID and Client Secret your application needs to
          register with Exotel.
        </p>

        <div class="warn">
          <span>&#9888;</span>
          <span><b>You can do this once.</b> Copy both values into your
          environment file before closing this page.</span>
        </div>

        <form id="f" autocomplete="off">
          <label>
            <span>Account SID</span>
            <input id="sid" type="text" required spellcheck="false" placeholder="your Exotel account sid" />
          </label>
          <label>
            <span>Administrator email</span>
            <input id="email" type="email" required spellcheck="false" placeholder="admin@yourcompany.com" />
            <span class="hint">The email registered on the Exotel account.</span>
          </label>
          <button class="go" id="go" type="submit">Generate credentials</button>
        </form>
        <p class="msg" id="msg"></p>
      </div>

      <div id="resultView" hidden>
        <h1>Your credentials</h1>
        <p class="sub">Copy both values now. This page will not show them again.</p>
        <div class="cred">
          <div class="l">Client ID</div>
          <div class="r"><span class="v" id="cid"></span><button class="copy" data-t="cid" type="button">Copy</button></div>
        </div>
        <div class="cred">
          <div class="l">Client Secret</div>
          <div class="r"><span class="v" id="csec"></span><button class="copy" data-t="csec" type="button">Copy</button></div>
        </div>
        <button class="copy" id="both" type="button" style="width:100%;padding:9px;font-size:.78rem">
          Copy both as environment variables
        </button>
        <p class="foot">
          Store these in a password manager. Anyone holding the pair can place
          calls billed to your Exotel account. Section 7 of your integration
          guide explains where they are used.
        </p>
      </div>

    </div>
  </div>
</div>

<script>
const ENDPOINT = ${JSON.stringify(URL)};
const STORE_KEY = "exotel_credentials_generated";

function priorFor(sid) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return all[String(sid).toLowerCase()] || null;
  } catch (e) { return null; }
}
function recordFor(sid) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    all[String(sid).toLowerCase()] = { at: new Date().toISOString() };
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (e) {}
}
function showBlocked(sid, when) {
  document.getElementById("blockedText").textContent =
    "This page generated credentials for " + sid +
    (when ? " on " + new Date(when).toLocaleDateString() : "") + ".";
  document.getElementById("formView").hidden = true;
  document.getElementById("resultView").hidden = true;
  document.getElementById("blockedView").hidden = false;
}

let issued = null;

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  const go = document.getElementById("go");
  msg.textContent = "";

  const sid = document.getElementById("sid").value.trim();
  const email = document.getElementById("email").value.trim();
  if (!sid || !email) { msg.textContent = "Both fields are required."; return; }

  const prior = priorFor(sid);
  if (prior) { showBlocked(sid, prior.at); return; }

  go.disabled = true;
  go.textContent = "Generating...";
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ CustomerName: sid, Email: email }),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (err) {}

    if (!r.ok || (data && data.Status && data.Status !== "Success")) {
      msg.textContent = "That did not work. Check the Account SID and administrator email, then email hello@exotel.in if it still fails.";
      return;
    }

    // Find the pair by name wherever it sits in the response.
    const found = {};
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      for (const k in node) {
        const v = node[k];
        const key = k.toLowerCase().replace(/[^a-z]/g, "");
        if (typeof v === "string") {
          if (!found.clientId && (key === "clientid" || key === "id")) found.clientId = v;
          if (!found.clientSecret && (key === "clientsecret" || key === "secret")) found.clientSecret = v;
        } else walk(v);
      }
    })(data);

    if (!found.clientId || !found.clientSecret) {
      msg.textContent = "The credentials could not be read from the response. Email hello@exotel.in quoting your Account SID.";
      return;
    }

    recordFor(sid);
    issued = found;
    document.getElementById("cid").textContent = found.clientId;
    document.getElementById("csec").textContent = found.clientSecret;
    document.getElementById("formView").hidden = true;
    document.getElementById("resultView").hidden = false;
    window.addEventListener("beforeunload", (ev) => { ev.preventDefault(); ev.returnValue = ""; });
  } catch (err) {
    msg.textContent = "Could not reach Exotel. Check your internet connection and try again.";
  } finally {
    go.disabled = false;
    go.textContent = "Generate credentials";
  }
});

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e2) {}
    document.body.removeChild(ta);
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".copy");
  if (!b || !issued) return;
  if (b.id === "both") {
    await copyText("EXOTEL_CLIENT_ID=" + issued.clientId + "\\nEXOTEL_CLIENT_SECRET=" + issued.clientSecret);
  } else {
    await copyText(document.getElementById(b.dataset.t).textContent);
  }
  const old = b.textContent;
  b.textContent = "Copied"; b.classList.add("done");
  setTimeout(() => { b.textContent = old; b.classList.remove("done"); }, 1400);
});
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page);

console.log(`\n  Credential generator written`);
console.log(`  ----------------------------`);
console.log(`  File : ${OUT}`);
console.log(`  Size : ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(`\n  Send this file to the customer. They open it, enter their Account SID`);
console.log(`  and administrator email, and receive their credentials.`);
console.log(`\n  Note: the file contains the provisioning endpoint, so anyone you send it`);
console.log(`  to can read it out of the file. That is inherent to the customer\n` +
            `  generating without a server in between.\n`);
