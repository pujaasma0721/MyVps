/**
 * Central configuration loader.
 * Reads .env once (.env.example lists every variable).
 * Architecture constants that must NOT be guessed at runtime come from here.
 */
require("dotenv").config();

function str(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    // Do not crash a fresh checkout — warn loudly and continue so the app can
    // still boot in demo mode before the operator fills the real .env.
    console.warn(`[config] WARNING: env ${name} is not set — using demo placeholder.`);
    return "MISSING-" + name;
  }
  return String(v).trim();
}

function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback) {
  const v = (process.env[name] || "").toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

const config = {
  port: int("PORT", 3500),
  env: str("NODE_ENV", "development"),
  sessionSecret: str("SESSION_SECRET", "dev-only-insecure-secret-change-me-32chars"),
  // AES key for encrypting VPS OS passwords at rest (hex, 32 bytes). Generate:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  vpsPasswordKey: str("VPS_PASSWORD_KEY", ""),
  appBaseUrl: str("APP_BASE_URL", "http://localhost:3500"),

  dbUrl: process.env.DATABASE_URL || "",

  // Business identity
  publicIp: str("PUBLIC_IP"),
  mainDomain: str("MAIN_DOMAIN"),

  // Proxmox
  proxmox: {
    mock: bool("PROXMOX_MOCK", false),
    node: str("PROXMOX_NODE", "pve"),
    templateId: int("PROXMOX_TEMPLATE_ID", 100),
    apiUrl: str("PROXMOX_API_URL", "https://127.0.0.1:8006"),
    tokenUser: str("PROXMOX_TOKEN_USER", "root@pam"),
    tokenId: str("PROXMOX_TOKEN_ID", "myvps"),
    apiKey: str("PROXMOX_API_KEY", ""),
    insecureTls: bool("PROXMOX_INSECURE_TLS", true),
  },

  smtp: {
    host: str("SMTP_HOST", ""),
    port: int("SMTP_PORT", 587),
    user: str("SMTP_USER", ""),
    pass: str("SMTP_PASS", ""),
    from: str("SMTP_FROM", "MYVPS <noreply@example.com>"),
  },

  payment: {
    note: str("PAYMENT_NOTE", "Transfer sesuai nominal, lalu upload bukti."),
  },

  admin: {
    email: str("ADMIN_EMAIL", "admin@myvps.local"),
    password: str("ADMIN_PASSWORD", "Admin#1234"),
    name: str("ADMIN_NAME", "Administrator"),
  },

  uploads: {
    proofDir: process.env.UPLOAD_DIR || "uploads/proof",
    maxProofBytes: int("PROOF_MAX_BYTES", 2 * 1024 * 1024), // 2 MB
  },
}

// Fail-fast: refuse to run production with insecure defaults (audit fix #2).
if (config.env === "production") {
  const problems = [];
  if (config.sessionSecret === "dev-only-insecure-secret-change-me-32chars") {
    problems.push("SESSION_SECRET is still the development default");
  }
  if (!config.vpsPasswordKey || config.vpsPasswordKey.length !== 64) {
    problems.push("VPS_PASSWORD_KEY must be 32-byte hex (64 chars) for password encryption");
  }
  if (problems.length) {
    console.error("[config] REFUSING production boot — insecure configuration:");
    problems.forEach((p) => console.error("  - " + p));
    process.exit(1);
  }
}

module.exports = config;