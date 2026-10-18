"use strict";
/**
 * Demo-mode shell recorder.
 * Instead of running the real /usr/bin/sudo commands, Appends a readable line
 * into outputs/mock/shell-history.jsonl so the exact production commands
 * remain inspectable in tests.
 */
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(process.cwd(), "outputs", "mock");
const LOG_FILE = path.join(LOG_DIR, "shell-history.jsonl");

function record(bin, args, ok) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), bin, args , ok })}\n`);
}

/**
 * Mirror of the real semaphore of shell.js:
 *  - nginx -t           : succeeds unless the host previously marked config bad
 *  - nginx -s reload    : succeeds
 *  - iptables -A/-D     : succeeds
 *  - iptables-save      : returns plausible dump text
 *  - certbot ...        : succeeds (delete also succeeds even when absent,
 *                          matching the "ignore errors" contract)
 */
function exec(bin, args, resolve, reject) {
  // nginx config invalidation hook for tests:
  if (bin.endsWith("/nginx") && args[0] === "-t" && lastWrittenConfBad) {
    lastWrittenConfBad = false;
    record(bin, args, false);
    return reject(new Error("nginx: [emerg] mock bad config test failure"));
  }
  record(bin, args, true);
  if (bin.endsWith("/iptables-save")) {
    return resolve({ stdout: "*nat\n:PREROUTING ACCEPT [0:0]\nCOMMIT\n", stderr: "" });
  }
  resolve({ stdout: "", stderr: "" });
}

let lastWrittenConfBad = false;

/** Test hook: next `nginx -t` fails (simulates a broken vhost). */
function failNextNginxTest() {
  lastWrittenConfBad = true;
}

module.exports = { exec, failNextNginxTest };
