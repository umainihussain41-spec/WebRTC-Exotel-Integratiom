/**
 * Renders an HTML string to a PDF using the local Chrome install.
 * No service, no dependency: Chrome is driven over the DevTools protocol so
 * background colour is preserved, which the --print-to-pdf CLI flag drops.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error("Chrome was not found. Set CHROME_PATH to its location.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function htmlToPdf(html, outPath, opts = {}) {
  const chromePath = findChrome();
  const port = 9500 + crypto.randomInt(0, 400);
  const tmpHtml = path.join(os.tmpdir(), `render-${crypto.randomUUID()}.html`);
  fs.writeFileSync(tmpHtml, html);

  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + path.join(os.tmpdir(), "chrome-render-" + crypto.randomUUID()),
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--font-render-hinting=none",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { up = true; break; } } catch (e) {}
      await sleep(250);
    }
    if (!up) throw new Error("Chrome did not start");

    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    await new Promise((r) => ws.addEventListener("open", r));
    const loaded = new Promise((r) => {
      ws.addEventListener("message", (ev) => {
        if (JSON.parse(ev.data).method === "Page.loadEventFired") r();
      });
    });
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        return m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });

    await send("Page.enable");
    await send("Page.navigate", { url: "file:///" + tmpHtml.replace(/\\/g, "/") });
    await loaded;
    await sleep(opts.settleMs || 2500); // let web fonts arrive

    const pdf = await send("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(pdf.data, "base64"));
    return outPath;
  } finally {
    chrome.kill();
    fs.rmSync(tmpHtml, { force: true });
  }
}

module.exports = { htmlToPdf };
