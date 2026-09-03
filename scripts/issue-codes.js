#!/usr/bin/env node
/**
 * Mint single-use access codes for the credential portal.
 *
 *   node scripts/issue-codes.js 5            create five codes
 *   node scripts/issue-codes.js --list       show status without creating any
 *
 * Only the SHA-256 of each code is stored, so the plain codes below are the
 * only copy. Hand one to each customer alongside the integration guide.
 *
 * On a platform with an ephemeral filesystem, point CRED_STORE_PATH at a
 * mounted volume or the record of which codes have been spent is lost on the
 * next deploy.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_PATH =
  process.env.CRED_STORE_PATH || path.join(__dirname, "..", "data", "credential-issuance.json");

const read = () => {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); }
  catch (e) { return { codes: {}, issued: {} }; }
};
const write = (db) => {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(db, null, 2));
};
const hash = (c) => crypto.createHash("sha256").update(c.trim().toUpperCase()).digest("hex");

// Crockford-style alphabet: no I, L, O, U, so codes survive being read aloud
// or copied off a screen.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newCode() {
  const pick = () => ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join("");
  return `${group()}-${group()}-${group()}`;
}

const db = read();
const args = process.argv.slice(2);

if (args.includes("--list")) {
  const codes = Object.values(db.codes);
  const used = codes.filter((c) => c.usedAt);
  console.log(`store   : ${STORE_PATH}`);
  console.log(`codes   : ${codes.length} total, ${used.length} used, ${codes.length - used.length} unused`);
  console.log(`accounts: ${Object.keys(db.issued).length} issued`);
  for (const [sid, rec] of Object.entries(db.issued)) {
    console.log(`  ${sid.padEnd(20)} ${rec.at}  client id ${rec.clientId}`);
  }
  process.exit(0);
}

const count = Math.max(1, Math.min(50, parseInt(args[0], 10) || 1));
const minted = [];
for (let i = 0; i < count; i++) {
  const code = newCode();
  db.codes[hash(code)] = { createdAt: new Date().toISOString(), usedAt: null, accountSid: null };
  minted.push(code);
}
write(db);

console.log(`\nMinted ${minted.length} single-use access code(s).`);
console.log("Only the hash is stored, so this is the only copy:\n");
minted.forEach((c) => console.log("  " + c));
console.log(`\nStore: ${STORE_PATH}`);
console.log("Each code works once, and each Account SID can be served once.\n");
