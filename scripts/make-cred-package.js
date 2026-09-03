#!/usr/bin/env node
/**
 * Builds a sealed, offline credential file for one customer.
 *
 *   node scripts/make-cred-package.js --sid exotel243m --email admin@acme.com
 *   node scripts/make-cred-package.js --sid exotel243m --client-id X --client-secret Y
 *
 * The design point: we encrypt the CREDENTIALS, never the endpoint.
 *
 * You run the provisioning call here, on your own machine. The customer
 * receives a single HTML file containing nothing but their own Client ID and
 * Secret, sealed with AES-256-GCM. The provisioning endpoint appears nowhere in
 * it, so there is nothing to extract even in principle. Contrast with shipping
 * an encrypted endpoint: anything the customer's machine can decrypt in order
 * to use, the customer can also decrypt in order to read.
 *
 * The passphrase is printed here and never written into the file. Send it by a
 * different channel from the file itself.
 *
 * Key derivation: PBKDF2-HMAC-SHA256, 310,000 iterations, 16 byte random salt.
 * Encryption:     AES-256-GCM, 12 byte random IV, authenticated.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PBKDF2_ITERATIONS = 310000;
const OUT_DIR = path.join(__dirname, "..", "out");

// One generation per account, enforced here because this is the only place it
// can be enforced. The customer's copy cannot mint anything, so the rule has to
// live on the side that actually makes the provisioning call. Re-running would
// also risk creating a duplicate customer record upstream.
const LEDGER = process.env.CRED_LEDGER_PATH || path.join(__dirname, "..", "data", "sealed-packages.json");

function ledgerRead() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch (e) { return { issued: {} }; }
}
function ledgerWrite(db) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(db, null, 2));
}

// ---- arguments -------------------------------------------------------------
const args = {};
process.argv.slice(2).forEach((a, i, all) => {
  if (a.startsWith("--")) args[a.slice(2)] = all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true;
});

const sid = args.sid;
const email = args.email;
if (!sid) {
  console.error("\nUsage:\n  node scripts/make-cred-package.js --sid <account sid> --email <admin email>\n" +
                "  node scripts/make-cred-package.js --sid <account sid> --client-id <id> --client-secret <secret>\n");
  process.exit(1);
}

// Crockford-style alphabet: no I, L, O or U, so the passphrase survives being
// read down a phone line.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function passphrase() {
  const g = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join("");
  return `${g()}-${g()}-${g()}-${g()}-${g()}`; // 100 bits
}

// ---- obtain the credentials ------------------------------------------------
async function getCredentials() {
  if (args["client-id"] && args["client-secret"]) {
    return { clientId: args["client-id"], clientSecret: args["client-secret"], source: "supplied" };
  }
  const base = process.env.CRED_UPSTREAM_BASE;
  const upstreamPath = process.env.CRED_UPSTREAM_PATH;
  if (!base || !upstreamPath) {
    throw new Error(
      "Set CRED_UPSTREAM_BASE and CRED_UPSTREAM_PATH in .env to call the provisioning\n" +
      "  service, or pass --client-id and --client-secret to seal values you already have."
    );
  }
  if (!email) throw new Error("--email is required when the provisioning call is used.");

  const url = base.replace(/\/+$/, "") + "/" + upstreamPath.replace(/^\/+/, "");
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ CustomerName: sid, Email: email }),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (!r.ok || (data && data.Status && data.Status !== "Success")) {
    throw new Error(`provisioning refused: HTTP ${r.status} ${(data && data.Error) || text.slice(0, 160)}`);
  }

  // Locate the pair by key name wherever it sits in the response.
  const found = {};
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      const key = k.toLowerCase().replace(/[^a-z]/g, "");
      if (typeof v === "string") {
        if (!found.clientId && (key === "clientid" || key === "id")) found.clientId = v;
        if (!found.clientSecret && (key === "clientsecret" || key === "secret")) found.clientSecret = v;
      } else walk(v);
    }
  })(data);

  if (!found.clientId || !found.clientSecret) {
    throw new Error("the response did not contain a recognisable Client ID and Secret");
  }
  return { ...found, source: "provisioned" };
}

// ---- seal ------------------------------------------------------------------
function seal(plaintext, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pass, salt, PBKDF2_ITERATIONS, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    // WebCrypto expects the GCM tag appended to the ciphertext.
    data: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64"),
  };
}

// ---- the customer-facing page ---------------------------------------------
function buildPage(sealed, accountSid) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<title>Exotel credentials &middot; ${accountSid}</title>
<style>
:root{
  --navy:#1e3a5f; --green:#0f9d7a; --red:#d1494b; --link:#2b5fb8;
  --bg:#f4f6f9; --surface:#fff; --surface-2:#f7f9fb;
  --border:#e3e7ed; --border-strong:#ccd3dd;
  --text:#1c2434; --text-soft:#59636f; --text-faint:#8a94a1;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --font:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.5}
.wrap{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px 64px}
.card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);
      border-radius:8px;box-shadow:0 1px 2px rgba(28,36,52,.06),0 4px 12px rgba(28,36,52,.07);overflow:hidden}
.band{background:var(--navy);color:#fff;padding:12px 16px}
.band .b{font-size:.74rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase}
.band .s{font-size:.68rem;color:rgba(255,255,255,.65);font-family:var(--mono)}
.body{padding:18px}
h1{margin:0 0 5px;font-size:1.04rem;font-weight:700}
.sub{margin:0 0 16px;font-size:.83rem;color:var(--text-soft)}
label{display:block;margin-bottom:12px}
label span{display:block;font-size:.7rem;font-weight:700;color:var(--text-soft);margin-bottom:4px}
input{width:100%;height:38px;padding:0 10px;border:1px solid var(--border-strong);border-radius:4px;
      background:var(--surface);font-family:var(--mono);font-size:.92rem;letter-spacing:.06em;
      text-transform:uppercase;color:var(--text);outline:none}
input:focus{border-color:var(--green);box-shadow:0 0 0 2px rgba(15,157,122,.15)}
button.go{width:100%;height:38px;border:0;border-radius:4px;background:var(--green);color:#fff;
          font:inherit;font-size:.85rem;font-weight:600;cursor:pointer}
button.go:hover{filter:brightness(1.05)}
button.go:disabled{opacity:.5;cursor:not-allowed}
.msg{margin:10px 0 0;font-size:.79rem;min-height:1em;color:var(--red)}
.cred{border:1px solid var(--border-strong);border-radius:4px;background:var(--surface-2);padding:10px 11px;margin-bottom:9px}
.cred .l{font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-faint);margin-bottom:4px}
.cred .r{display:flex;gap:8px;align-items:center}
.cred .v{flex:1;font-family:var(--mono);font-size:.8rem;word-break:break-all;line-height:1.45}
.copy{flex:none;border:1px solid var(--border-strong);background:var(--surface);color:var(--text-soft);
      font:inherit;font-size:.68rem;font-weight:600;padding:3px 9px;border-radius:3px;cursor:pointer}
.copy.done{background:var(--green);border-color:var(--green);color:#fff}
.warn{display:flex;gap:8px;background:#fdf6e8;border:1px solid #f0e2c6;border-radius:4px;
      padding:9px 11px;margin:0 0 14px;font-size:.76rem;color:#7a5510}
.foot{margin:14px 0 0;padding-top:11px;border-top:1px solid var(--border);font-size:.73rem;color:var(--text-faint)}
.offline{margin:0 0 14px;font-size:.72rem;color:var(--text-faint)}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="band">
      <div class="b">Exotel</div>
      <div class="s">${accountSid}</div>
    </div>
    <div class="body">
      <div id="lockView">
        <h1>Your WebRTC credentials</h1>
        <p class="sub">
          This file holds the Client ID and Client Secret for account
          <strong>${accountSid}</strong>, sealed. Enter the passphrase you were
          sent separately to open it.
        </p>
        <p class="offline">
          This page works entirely offline. Nothing is sent anywhere, and the
          file contains only your own credentials.
        </p>
        <form id="f" autocomplete="off">
          <label>
            <span>Passphrase</span>
            <input id="pass" type="text" required spellcheck="false"
                   placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" />
          </label>
          <button class="go" id="go" type="submit">Unseal</button>
        </form>
        <p class="msg" id="msg"></p>
      </div>

      <div id="openView" hidden>
        <h1>Your credentials</h1>
        <p class="sub">Copy both values into your environment file now.</p>
        <div class="warn">
          <span>&#9888;</span>
          <span>Store these in a password manager. Anyone holding this pair can
          place calls billed to your Exotel account.</span>
        </div>
        <div class="cred">
          <div class="l">Client ID</div>
          <div class="r"><span class="v" id="cid"></span><button class="copy" data-t="cid" type="button">Copy</button></div>
        </div>
        <div class="cred">
          <div class="l">Client Secret</div>
          <div class="r"><span class="v" id="csec"></span><button class="copy" data-t="csec" type="button">Copy</button></div>
        </div>
        <button class="copy" id="both" type="button" style="width:100%;padding:8px;font-size:.76rem">
          Copy both as environment variables
        </button>
        <p class="foot">
          Section 5 of your integration guide explains where these are used. If
          they are lost, contact your Exotel representative; this file cannot
          reissue them.
        </p>
      </div>
    </div>
  </div>
</div>

<script>
const SEALED = ${JSON.stringify(sealed)};
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  const go = document.getElementById("go");
  msg.textContent = "";

  if (!crypto || !crypto.subtle) {
    msg.textContent = "This browser cannot decrypt the file. Open it in Chrome, Edge, Firefox or Safari.";
    return;
  }

  go.disabled = true;
  go.textContent = "Unsealing...";
  try {
    const pass = document.getElementById("pass").value.trim().toUpperCase();
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64(SEALED.kdf.salt), iterations: SEALED.kdf.iterations, hash: SEALED.kdf.hash },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64(SEALED.iv) }, key, b64(SEALED.data)
    );
    const creds = JSON.parse(new TextDecoder().decode(plain));

    document.getElementById("cid").textContent = creds.clientId;
    document.getElementById("csec").textContent = creds.clientSecret;
    window.__creds = creds;
    document.getElementById("lockView").hidden = true;
    document.getElementById("openView").hidden = false;
  } catch (err) {
    // AES-GCM is authenticated, so a wrong passphrase fails here rather than
    // producing plausible rubbish.
    msg.textContent = "That passphrase did not work. Check it and try again.";
  } finally {
    go.disabled = false;
    go.textContent = "Unseal";
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
  if (!b || !window.__creds) return;
  if (b.id === "both") {
    await copyText("EXOTEL_CLIENT_ID=" + window.__creds.clientId + "\\nEXOTEL_CLIENT_SECRET=" + window.__creds.clientSecret);
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
}

// ---- run -------------------------------------------------------------------
(async () => {
  try {
    const ledger = ledgerRead();
    const key = sid.toLowerCase();
    const prior = ledger.issued[key];

    if (args.list) {
      const rows = Object.entries(ledger.issued);
      console.log(`\n  Sealed packages issued: ${rows.length}\n`);
      for (const [s, r] of rows) {
        console.log(`  ${s.padEnd(20)} ${r.at}   client id ${r.clientId}${r.regenerated ? `   regenerated x${r.regenerated}` : ""}`);
      }
      console.log("");
      return;
    }

    if (prior && !args.force) {
      console.error(
        `\n  Refusing: a sealed package was already issued for ${sid}.\n` +
        `    when      : ${prior.at}\n` +
        `    client id : ${prior.clientId}\n\n` +
        `  Credentials are issued once per account. If the customer has lost them or\n` +
        `  needs a genuine reissue, that is a support decision, not a routine re-run.\n` +
        `  Override deliberately with --force once you have decided.\n`
      );
      process.exitCode = 1;
      return;
    }
    if (prior && args.force) {
      console.log(`\n  --force: re-issuing for ${sid}, previously issued ${prior.at}.`);
      console.log(`  This may create a second customer record upstream.\n`);
    }

    const creds = await getCredentials();
    const pass = passphrase();
    const sealed = seal(JSON.stringify({
      accountSid: sid,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      issuedAt: new Date().toISOString(),
    }), pass);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${sid}-exotel-credentials.html`);
    fs.writeFileSync(file, buildPage(sealed, sid));

    // Record the issue. The secret is never written here, only the client id,
    // so the ledger says who was served without holding anything sensitive.
    ledger.issued[key] = {
      at: new Date().toISOString(),
      clientId: creds.clientId,
      source: creds.source,
      regenerated: prior ? (prior.regenerated || 0) + 1 : 0,
    };
    ledgerWrite(ledger);

    console.log(`\n  Sealed credential file written`);
    console.log(`  ------------------------------`);
    console.log(`  Account   : ${sid}`);
    console.log(`  Source    : ${creds.source === "provisioned" ? "provisioning call" : "values you supplied"}`);
    console.log(`  File      : ${file}`);
    console.log(`\n  PASSPHRASE: ${pass}`);
    console.log(`\n  Send the file and the passphrase by different channels. The passphrase`);
    console.log(`  is not stored anywhere, so this is the only copy.\n`);
  } catch (err) {
    console.error("\n  Failed: " + err.message + "\n");
    process.exitCode = 1;
  }
})();
