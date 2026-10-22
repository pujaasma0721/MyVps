"use strict";
/**
 * ADMIN routes (Region 3).
 * Everything behind requireAdmin.
 */
const express = require("express");
const prisma = require("../lib/prisma");
const { requireAdmin } = require("../middleware/auth");
const { hostHealth, customerVmsLive, adminHealth } = require("../services/monitoring");
const { nucleusRollback } = require("../services/nucleus");
const { verifyInvoice } = require("../services/finance");
const { extendOrder } = require("../services/expiry");

const router = express.Router();
router.use(requireAdmin);

// ---- Dashboard: Host OS health -----------------------------------------
router.get("/", async (req, res, next) => {
  try {
    const health = await adminHealth();
    const [{ count: ordersActive } = { count: 0 }, { count: ordersTotal } = { count: 0 }] = await Promise.all([
      prisma.order.count({ where: { status: "ACTIVE" } }),
      prisma.order.count(),
    ]);
    res.render("pages/admin/dashboard", { title: "Admin — Host Health", health, ordersActive, ordersTotal, user: req.user });
  } catch (e) { next(e); }
});

// JSON snapshot for the auto-refresh dashboard (same data as GET /admin)
router.get("/health-data", async (req, res, next) => {
  try {
    const data = await adminHealth();
    res.set("Cache-Control", "no-store");
    res.json(data);
  } catch (e) { next(e); }
});

// ---- VM management table -------------------------------------------------
router.get("/vps", async (req, res, next) => {
  try {
    const vms = await customerVmsLive();
    res.render("pages/admin/vps", { title: "Admin — Manajemen VM", vms, user: req.user });
  } catch (e) { next(e); }
});

// Perpanjang masa aktif VM (renewal): +N bulan dari sisi masa aktif terakhir.
router.post("/vps/:orderId/extend", async (req, res, next) => {
  try {
    await extendOrder(req.params.orderId, req.body.months);
    res.redirect(String(req.body.back || "/admin/vps"));
  } catch (e) { next(e); }
});

// re-render just the rows for polling refresh:
router.get("/vps/rows", async (req, res, next) => {
  try {
    const vms = await customerVmsLive();
    res.render("admin/_vps_rows", { vms });
  } catch (e) { next(e); }
});

// ---- Finance: invoices + revenue chart -----------------------------------
router.get("/finance", async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { status: { not: "REJECTED" } },
      include: { invoice: true, user: true, package: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    // monthly gross revenue (verified only)
    const grouped = await prisma.monthlyRevenueItem.groupBy({
      by: ["monthKey"],
      _sum: { amount: true },
      orderBy: { monthKey: "asc" },
      take: 12,
    });
    const chart = grouped.map((g) => ({ month: g.monthKey, total: Number(g._sum.amount ?? 0) }));
    res.render("pages/admin/finance", { title: "Admin — Verifikasi Keuangan", orders, chart, user: req.user });
  } catch (e) { next(e); }
});

// invoice detail partial (for lightbox framing)
router.get("/finance/proof/:orderId", async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      include: { invoice: true, user: true, package: true, vps: true },
    });
    if (!order) return res.status(404).json({ error: "not found" });
    res.render("admin/_invoice_card", { o: order });
  } catch (e) { next(e); }
});

// VERIFY (mark proof valid) — also books the monthly revenue row idempotently
router.post("/finance/:orderId/verify", async (req, res, next) => {
  try {
    await verifyInvoice(req.params.orderId, req.user.id, true);
    res.redirect("/admin/finance");
  } catch (e) { next(e); }
});

// REJECT -> NUCLEAR rollback (Region 3.2)
router.post("/finance/:orderId/reject", async (req, res, next) => {
  try {
    const reason = String(req.body.reason || "").trim() || "Bukti transfer tidak valid (admin).";
    await nucleusRollback(req.params.orderId, "REJECTED", reason);
    res.redirect("/admin/finance");
  } catch (e) { next(e); }
});

// ---- Package CRUD ---------------------------------------------------------
router.get("/packages", async (req, res, next) => {
  try {
    const packages = await prisma.package.findMany({ orderBy: { sortOrder: "asc" } });
    res.render("pages/admin/packages", { title: "Admin — Paket VPS", packages, extra: null, user: req.user, editing: null });
  } catch (e) { next(e); }
});

router.post("/packages", async (req, res, next) => {
  try {
    const { name, kind, vcpu, ramMb, diskGb, priceMonthly } = req.body;
    await prisma.package.create({
      data: {
        name: String(name).trim(),
        kind: kind === "LXC" ? "LXC" : "KVM",
        vcpu: parseInt(vcpu, 10),
        ramMb: parseInt(ramMb, 10),
        diskGb: parseInt(diskGb, 10),
        priceMonthly: parseFloat(priceMonthly),
        sortOrder: 99,
      },
    });
    res.redirect("/admin/packages");
  } catch (e) { next(e); }
});

router.get("/packages/:id/edit", async (req, res, next) => {
  try {
    const packages = await prisma.package.findMany({ orderBy: { sortOrder: "asc" } });
    const editing = packages.find((p) => p.id === req.params.id) || null;
    res.render("pages/admin/packages", { title: "Admin — Paket VPS", packages, editing, extra: null, user: req.user });
  } catch (e) { next(e); }
});

router.post("/packages/:id", async (req, res, next) => {
  try {
    const { name, kind, vcpu, ramMb, diskGb, priceMonthly, isActive } = req.body;
    await prisma.package.update({
      where: { id: req.params.id },
      data: {
        name: String(name).trim(),
        kind: kind === "LXC" ? "LXC" : "KVM",
        vcpu: parseInt(vcpu, 10),
        ramMb: parseInt(ramMb, 10),
        diskGb: parseInt(diskGb, 10),
        priceMonthly: parseFloat(priceMonthly),
        isActive: isActive === "on" || isActive === "true",
      },
    });
    res.redirect("/admin/packages");
  } catch (e) { next(e); }
});

router.post("/packages/:id/delete", async (req, res, next) => {
  try {
    await prisma.package.delete({ where: { id: req.params.id } }).catch(() => {});
    res.redirect("/admin/packages");
  } catch (e) { next(e); }
});

module.exports = router;
