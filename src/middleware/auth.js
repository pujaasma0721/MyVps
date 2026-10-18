"use strict";
/**
 * Session auth (cookie sid -> DB Session row) with bcrypt-hashed passwords.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");
const config = require("../config");

const COOKIE = "myvps_sid";
const TTL_MS = 7 * 24 * 3600 * 1000;

async function login(email, password) {
  const user = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
  if (!user) return null;
  if (!(await bcrypt.compare(String(password), user.passwordHash))) return null;
  return user;
}

async function register({ fullName, email, password, whatsapp }) {
  const emailNorm = String(email).trim().toLowerCase();
  const exists = await prisma.user.findUnique({ where: { email: emailNorm } });
  if (exists) {
    const e = new Error("EMAIL_TAKEN");
    e.code = "EMAIL_TAKEN";
    throw e;
  }
  return prisma.user.create({
    data: {
      fullName: String(fullName).trim(),
      email: emailNorm,
      passwordHash: await bcrypt.hash(String(password), 10),
      whatsapp: whatsapp ? String(whatsapp).trim() : null,
    },
  });
}

async function createSession(res, userId) {
  const id = crypto.randomBytes(24).toString("hex");
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + TTL_MS) } });
  res.cookie(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: TTL_MS,
    secure: config.env === "production",
  });
}

async function destroySession(req, res) {
  const sid = req.cookies[COOKIE];
  if (sid) await prisma.session.deleteMany({ where: { id: sid } }).catch(() => {});
  res.clearCookie(COOKIE);
}

function loadUser() {
  return async (req, res, next) => {
    const sid = req.cookies[COOKIE];
    if (!sid) return next();
    const session = await prisma.session.findUnique({
      where: { id: sid },
      include: { user: true },
    }).catch(() => null);
    if (session && session.expiresAt > new Date()) {
      req.user = session.user;
    } else if (session) {
      await prisma.session.delete({ where: { id: sid } }).catch(() => {});
    }
    next();
  };
}

function requireUser(req, res, next) {
  if (!req.user) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect("/login");
  if (!req.user.isAdmin) return res.status(403).render("pages/message", {
    title: "Akses Ditolak",
    message: "Halaman ini khusus administrator.",
    user: req.user,
  });
  next();
}

module.exports = { login, register, createSession, destroySession, loadUser, requireUser, requireAdmin, COOKIE };
