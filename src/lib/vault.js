"use strict";
/**
 * Vault: at-rest encryption for VPS OS passwords (audit fix #5).
 * AES-256-GCM keyed by VPS_PASSWORD_KEY (32-byte hex from .env).
 *
 * Storage format: "v1:" + 24-hex-iv + ":" + hex-ciphertext + ":" + 32-hex-tag
 * Legacy plaintext rows (no "v1:" prefix) are transparently accepted on read
 * and re-encrypted on next write — zero-downtime migration.
 */
const crypto = require("crypto");
const config = require("../config");

const PREFIX = "v1:";

function key() {
  if (!config.vpsPasswordKey || config.vpsPasswordKey.length !== 64) {
    throw new Error("vps-vault: VPS_PASSWORD_KEY missing/not 32-byte hex (64 chars)");
  }
  return Buffer.from(config.vpsPasswordKey, "hex");
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString("hex") + ":" + ct.toString("hex") + ":" + tag.toString("hex");
}

function decrypt(stored) {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext passthrough
  const [, ivHex, ctHex, tagHex] = stored.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

function isEncrypted(stored) {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
