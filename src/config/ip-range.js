"use strict";
/**
 * IP range helper for the fixed pool 10.0.0.100 .. 10.0.0.250.
 */
const { IP_START, IP_END } = require("./constants");

function ipToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Enumerate every IP in the fixed pool (inclusive). */
function enumeratePool() {
  const start = ipToInt(IP_START);
  const end = ipToInt(IP_END);
  const out = [];
  for (let n = start; n <= end; n++) out.push(intToIp(n));
  return out;
}

module.exports = { ipToInt, intToIp, enumeratePool };
