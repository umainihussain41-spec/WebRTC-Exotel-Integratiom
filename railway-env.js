/**
 * Prints the exact block to paste into Railway → Variables → Raw Editor.
 * Run:  node railway-env.js
 * Values come from your local .env; SESSION_SECRET is generated fresh.
 * Note: PORT is deliberately omitted — Railway injects its own.
 */
require("dotenv").config();
const crypto = require("crypto");

const KEYS = [
  "EXOTEL_ACCOUNT_SID", "EXOTEL_SUBDOMAIN", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN",
  "EXOTEL_CALLER_ID", "EXOTEL_REGION", "EXOTEL_EXOTEL_DOMAIN", "EXOTEL_ICORE_BASE",
  "EXOTEL_CLIENT_ID", "EXOTEL_CLIENT_SECRET", "EXOTEL_APP_NAME", "EXOTEL_APP_ID",
  "EXOTEL_APP_SECRET", "EXOTEL_WEBRTC_USER_ID", "EXOTEL_AGENT_NAME", "EXOTEL_AGENT_NUMBER",
];

const mask = process.argv.includes("--mask");
const missing = [];
for (const k of KEYS) {
  const v = process.env[k] || "";
  if (!v && k !== "EXOTEL_AGENT_NUMBER") missing.push(k);
  console.log(`${k}=${mask ? (v ? "<set:" + v.length + " chars>" : "") : v}`);
}
console.log(`SESSION_SECRET=${mask ? "<generated>" : crypto.randomBytes(32).toString("hex")}`);
console.log("APP_PASSWORD=<choose-a-password-and-type-it-here>");

if (missing.length) {
  console.error("\n!! missing from .env: " + missing.join(", "));
  process.exitCode = 1;
}
