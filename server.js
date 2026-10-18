"use strict";
/**
 * MYVPS Billing & Monitoring — server entry.
 * Runs as the isolated non-root system user `apps` on the Proxmox host
 * (Region 4); see DEPLOYMENT.md for sudoers + systemd wiring.
 */
const express = require("express");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const path = require("path");
const http = require("http");

const rateLimit = require("express-rate-limit");
const config = require("./src/config");
const { loadUser } = require("./src/middleware/auth");
const { router: publicRoutes, setLoginLimiter } = require("./src/routes/public");
const clientRoutes = require("./src/routes/client");
const adminRoutes = require("./src/routes/admin");
const prisma = require("./src/lib/prisma");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "src", "views"));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:", "blob:"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "style-src-elem": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "upgrade-insecure-requests": [],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
if (config.env !== "production") app.use(morgan("dev"));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// static: stylesheet, scripts, uploaded proofs + mock QRIS image
app.use("/static", express.static(path.join(__dirname, "public"), { maxAge: "1d" }));
app.use("/static/payment", express.static(path.join(__dirname, "public", "payment")));
app.use("/proofs", express.static(path.join(__dirname, "uploads"), { maxAge: "1d" }));

// boot-time auth load (reads cookie -> req.user)
app.use(loadUser());

// CSRF guard for stateful POSTs (audit fix #4): reject cross-origin form
// posts using the Origin header — a hostile page on another origin cannot
// forge requests with the correct origin. Same-origin POST & curl-style
// clients without an Origin header (native forms, API tools) pass through.
app.use((req, res, next) => {
  if (req.method !== "POST") return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser or same-origin GET-style submit
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return next();
  } catch (_e) { /* fallthrough */ }
  return res.status(403).render("pages/message", {
    title: "Permintaan Ditolak",
    message: "Permintaan POST lintas-origin (CSRF) diblokir.",
    user: req.user || null,
  });
});

// inject common EJS locals
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.mainDomain = config.mainDomain;
  next();
});

// Brute-force guard for credential endpoints (audit fix #3).
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 20,                 // 20 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: "Terlalu banyak percobaan. Coba lagi dalam 10 menit.",
});

setLoginLimiter(loginLimiter);
app.use("/", publicRoutes);
app.use("/client", clientRoutes);
app.use("/admin", adminRoutes);

// health probe for systemd
app.get("/healthz", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 404
app.use((req, res) => {
  res.status(404).render("pages/message", { title: "404", message: "Halaman tidak ditemukan.", currency: undefined });
});

// error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err);
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).render("pages/message", { title: "Terlalu besar", message: "Ukuran file bukti melebihi batas 2 MB." });
  }
  res.status(err.status || 500).render("pages/message", {
    title: "Kesalahan",
    message: err.userMessage || err.message || "Terjadi kesalahan tak terduga.",
  });
});

const server = http.createServer(app);
server.listen(config.port, () => {
  const mode = config.proxmox.mock ? "MOCK" : "REAL-PROXMOX";
  console.log(`myvps-billing listening on :${config.port} [${config.env}] proxmox=${mode} node=${config.proxmox.node} template=${config.proxmox.templateId}`);
});

// graceful shutdown
["SIGINT", "SIGTERM"].forEach((sig) =>
  process.on(sig, () => server.close(() => prisma.$disconnect().finally(() => process.exit(0))))
);

module.exports = app;
