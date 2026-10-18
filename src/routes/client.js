"use strict";
/**
 * CLIENT AREA routes — all scoping by req.user.id (Region 1 + 2.3).
 */
const express = require("express");
const path = require("path");
const prisma = require("../lib/prisma");
const { requireUser } = require("../middleware/auth");
const { proofUpload } = require("../lib/multer");
const vault = require("../lib/vault");
const shell = require("../lib/shell");
const config = require("../config");
const C = require("../config/constants");

const router = express.Router();
router.use(requireUser);

// ---- Overview ------------------------------------------------------------
router.get("/", async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { userId: req.user.id },
      include: { package: true, vps: true },
      orderBy: { createdAt: "desc" },
    });
    res.render("pages/client/dashboard", { title: "Client Area", orders, user: req.user, warningText: C.WARNING_24H_TEXT, publicIp: config.publicIp });
  } catch (e) { next(e); }
});

// ---- Order detail ---------------------------------------------------------
router.get("/order/:orderId", async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, userId: req.user.id }, // hard ownership scope
      include: { package: true, vps: true, invoice: true },
    });
    if (!order) return res.status(404).render("pages/message", { title: "404", message: "Pesanan tidak ditemukan.", user: req.user });
    res.render("pages/client/order-detail", {
      title: `VPS — ${order.id.slice(0, 8).toUpperCase()}`,
      order, user: req.user,
      publicIp: config.publicIp,
      mainDomain: config.mainDomain,
      warningText: C.WARNING_24H_TEXT,
      subDomain: `${order.id}.${config.mainDomain}`,
    });
  } catch (e) { next(e); }
});

// ---- Upload / replace QRIS proof --------------------------------------------
router.post("/order/:orderId/proof", proofUpload.single("proofImage"), async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({ where: { id: req.params.orderId, userId: req.user.id } });
    if (!order) return res.status(404).json({ error: "not found" });
    if (!req.file) return res.status(400).json({ error: "file gambar bukti wajib diunggah" });
    await prisma.order.update({
      where: { id: order.id },
      data: { proofImage: `uploads/proof/${req.file.filename}` },
    });
    res.redirect(`/client/order/${order.id}`);
  } catch (e) { next(e); }
});

// ---- Wire a://CUSTOM domain to the VPS (Region 2.3) ------------------------
// ---- Resend SSH credentials (audit fix #7 — password is never shown in UI) --
router.post("/order/:orderId/resend-credentials", async (req, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, userId: req.user.id },
      include: { vps: true, package: true },
    });
    if (!order || !order.vps) return res.status(404).json({ error: "Pesanan/VPS tidak ditemukan." });

    const vmPassword = vault.decrypt(order.vps.osPassword);
    const pkg = order.package;
    const text =
      `Kredensial VPS (kirim ulang):\n\n` +
      `  - IP Publik (NAT): ${config.publicIp}\n` +
      `  - Port SSH Kustom: ${order.vps.portCustom}\n` +
      `  - Username: ${C.VM_USER}\n` +
      `  - Password : ${vmPassword}\n\n` +
      `Subdomain default: ${order.id}.${config.mainDomain}\n` +
      `SSH: ssh ${C.VM_USER}@${config.publicIp} -p ${order.vps.portCustom}\n\n`;
    const html =
      `<p>Kredensial VPS (kirim ulang):</p><ul>` +
      `<li>IP Publik: <b>${config.publicIp}</b></li>` +
      `<li>Port SSH Kustom: <b>${order.vps.portCustom}</b></li>` +
      `<li>Username: <b>${C.VM_USER}</b></li>` +
      `<li>Password: <b>${vmPassword}</b></li></ul>` +
      `<p>SSH: <code>ssh ${C.VM_USER}@${config.publicIp} -p ${order.vps.portCustom}</code></p>`;
    const emailer = require("../lib/email");
    await emailer.sendMail({
      to: req.user.email,
      subject: `Kirim ulang kredensial VPS — ${order.id.slice(0, 8).toUpperCase()}`,
      text, html,
    });
    res.redirect(`/client/order/${order.id}`);
  } catch (e) { next(e); }
});

// ---- Wire a://CUSTOM domain to the VPS (Region 2.3) ------------------------
router.post("/order/:orderId/domain", async (req, res, next) => {
  try {
    const orderId = req.params.orderId;
    const domain = String(req.body.domain || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.\-]{2,252}$/.test(domain) || domain.includes("..")) {
      return res.status(400).json({ error: "Format domain tidak valid." });
    }
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: req.user.id },
      include: { vps: true },
    });
    if (!order || !order.vps) return res.status(404).json({ error: "Pesanan/VPS tidak ditemukan." });

    // The vhost writes a proxy_pass to the VPS:80 anchored on the wildcard
    // *.MAIN_DOMAIN cert — certbot only fires for CUSTOM domains.
    await shell.nginxAddDomain(domain, order.vps.ipInternal);
    await shell.certbotIssue(domain);
    await prisma.order.update({ where: { id: order.id }, data: { customDomain: domain } });
    res.json({ ok: true, domain });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
