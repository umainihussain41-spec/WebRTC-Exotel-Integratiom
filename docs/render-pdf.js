/**
 * Renders the integration guide to PDF using Chrome's print engine.
 *
 *   node docs/render-pdf.js
 *
 * The portal address printed in section 5.2 comes from PORTAL_URL so the
 * deployment address is not baked into the source:
 *
 *   PORTAL_URL=https://your-app.up.railway.app/credentials.html node docs/render-pdf.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9321);
const SRC = path.join(__dirname, "exotel-webrtc-guide.html");
const BUILT = path.join(os.tmpdir(), "exotel-guide-built.html");
const OUT = path.join(__dirname, "Exotel-WebRTC-Guide.pdf");
const PORTAL_URL = process.env.PORTAL_URL || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Substitute the portal address, if one was supplied, into a temporary copy so
// the checked-in source stays deployment neutral.
let html = fs.readFileSync(SRC, "utf8");
if (PORTAL_URL) {
  html = html.replace(
    "the credential portal at the address supplied with this guide",
    `the credential portal at <code>${PORTAL_URL}</code>`
  );
}
fs.writeFileSync(BUILT, html);

const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + path.join(os.tmpdir(), "cdp-guide-pdf"),
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--font-render-hinting=none",
  "about:blank",
], { stdio: "ignore" });

const FOOT = `
<div style="width:100%;font-family:'Source Sans 3',Arial,sans-serif;font-size:7pt;
            color:#6b7c93;padding:0 16mm;display:flex;justify-content:space-between;">
  <span>Browser Calling with Exotel</span>
  <span class="pageNumber"></span>
</div>`;

(async () => {
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch("http://127.0.0.1:" + PORT + "/json/version")).ok) break; } catch (e) {}
      await sleep(500);
    }
    const t = await (await fetch("http://127.0.0.1:" + PORT + "/json/new?about:blank", { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0; const pend = new Map();
    const send = (m, p) => new Promise((res, rej) => {
      const i = ++id; pend.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
    });
    await new Promise((r) => ws.addEventListener("open", r));
    const loaded = new Promise((r) => {
      ws.addEventListener("message", (ev) => {
        if (JSON.parse(ev.data).method === "Page.loadEventFired") r();
      });
    });
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) {
        const { res, rej } = pend.get(m.id); pend.delete(m.id);
        return m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: "file:///" + BUILT.replace(/\\/g, "/") });
    await loaded;
    await sleep(4000); // let the web fonts arrive and lay out

    const fonts = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        spectral: document.fonts.check('16px Spectral'),
        sans: document.fonts.check('16px "Source Sans 3"'),
        mono: document.fonts.check('16px "IBM Plex Mono"')
      })`, returnByValue: true,
    });
    console.log("fonts:", fonts.result.value);

    const pdf = await send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:0;height:0;"></div>`,
      footerTemplate: FOOT,
      marginTop: 0.75, marginBottom: 0.7, marginLeft: 0.63, marginRight: 0.63,
    });
    fs.writeFileSync(OUT, Buffer.from(pdf.data, "base64"));

    const raw = fs.readFileSync(OUT).toString("latin1");
    const pages = Math.max(...[...raw.matchAll(/\/Count\s+(\d+)/g)].map((m) => +m[1]));
    console.log(`wrote ${OUT}`);
    console.log(`pages: ${pages} | size: ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.error("ERR", e.message);
    process.exitCode = 1;
  } finally {
    chrome.kill();
    fs.rmSync(BUILT, { force: true });
  }
})();
