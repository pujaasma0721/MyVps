"use strict";
/**
 * Public + auth routes (landing, register/login, checkout).
 */
const express = require("express");
const path = require("path");
const prisma = require("../lib/prisma");
const { register, login, createSession, destroySession } = require("../middleware/auth");
const { proofUpload } = require("../lib/multer");
const { provisionInstantOrder, assertHostHasFreeRam } = require("../services/provisioning");
const config = require("../config");
const C = require("../config/constants");

const router = express.Router();

// ---- Landing page: active packages --------------------------------------
router.get("/", async (req, res, next) => {
  try {
    const packages = await prisma.package.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
    res.render("pages/home", { title: "MYVPS — VPS Rumah, Harga Kaki Lima", packages, user: req.user || null });
  } catch (e) { next(e); }
});

// ---- Auth ----------------------------------------------------------------
router.get("/login", (req, res) => {
  res.render("pages/login", { title: "Masuk", error: null, next: req.query.next || "/", user: null });
});

router.post("/login", async (req, res, next) => {
  try {
    const user = await login(req.body.email || "", req.body.password || "");
    if (!user) {
      return res.status(401).render("pages/login", { title: "Masuk", error: "Email atau password salah.", next: req.body.next || "/", user: null });
    }
    await createSession(res, user.id);
    res.redirect(user.isAdmin ? "/admin" : req.body.next || "/client");
  } catch (e) { next(e); }
});

router.get("/register", (req, res) => {
  res.render("pages/register", { title: "Daftar", errors: null, values: {}, user: null });
});

router.post("/register", async (req, res, next) => {
  const values = { fullName: req.body.fullName, email: req.body.email, whatsapp: req.body.whatsapp };
  try {
    const pw = String(req.body.password || "");
    if (pw.length < 8) {
      return res.status(400).render("pages/register", { title: "Daftar", errors: "Password minimal 8 karakter.", values, user: null });
    }
    const user = await register({
      fullName: req.body.fullName,
      email: req.body.email,
      password: pw,
      whatsapp: req.body.whatsapp,
    });
    await createSession(res, user.id);
    res.redirect("/client");
  } catch (e) {
    if (e.code === "EMAIL_TAKEN") {
      return res.status(409).render("pages/register", { title: "Daftar", errors: "Email sudah terdaftar.", values, user: null });
    }
    next(e);
  }
});

router.get("/logout", async (req, res, next) => {
  try { await destroySession(req, res); res.redirect("/"); } catch (e) { next(e); }
});

// ---- Checkout: QRIS + instant provisioning --------------------------------
router.get("/checkout/:packageId", async (req, res, next) => {
  try {
    const pkg = await prisma.package.findUnique({ where: { id: req.params.packageId } });
    if (!pkg || !pkg.isActive) return res.status(404).render("pages/message", { title: "Paket tidak ditemukan", message: "Paket tersebut tersedia.", user: req.user || null });
    res.render("pages/checkout", {
      title: `Checkout — ${pkg.name}`,
      pkg,
      user: req.user || null,
      mainDomain: config.mainDomain,
      paymentNote: config.payment.note,
      warningText: C.WARNING_24H_TEXT,
      amount: pkg.priceMonthly.mul(parseInt(req.query.months || "1", 10) || 1),
      months: parseInt(req.query.months || "1", 10) || 1,
      formulas: null,
    });
  } catch (e) { next(e); }
});

router.post("/checkout/:packageId", proofUpload.single("proofImage"), async (req, res, next) => {
  const pkgId = req.params.packageId;
  try {
    if (!req.user) return res.redirect("/login?next=" + encodeURIComponent(`/checkout/${pkgId}`));

    const months = parseInt(req.body.months, 10) || 1;
    const customDomainRaw = (req.body.customDomain || "").trim().toLowerCase();
    const proofRel = req.file
      ? `uploads/proof/${req.file.filename}`
      : null;

    // pause! free RAM is checked again so a stale form cannot overcommit
    const pkgRow = await prisma.package.findUnique({ where: { id: pkgId } });
    if (!pkgRow || !pkgRow.isActive) {
      const e = new Error("PACKAGE_NOT_FOUND");
      e.status = 404;
      throw e;
    }

    const { order } = await provisionInstantOrder({
      userId: req.user.id,
      packageId: pkgId,
      months,
      customDomain: customDomainRaw || null,
      proofImageRel: proofRel ? `uploads/proof/${path.basename(proofRel)}` : null,
    });

    res.redirect(`/client/order/${order.id}`);
  } catch (e) {
    if (e instanceof (require("../services/resources").ServerFullError)) {
      return res.status(503).render("pages/server-full", { title: "Server Penuh", user: req.user || null, message: e.message });
    }
    next(e);
  }
});

module.exports = router;
