"use strict";
/**
 * Transactional email via Nodemailer.
 * In demo mode (PROXMOX_MOCK=true) nothing leaves the machine: messages are
 * appended to outputs/mock/inbox.jsonl and a log line is printed.
 */
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const config = require("../config");

let transporter = null;
if (!config.proxmox.mock && config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

const INBOX = path.join(process.cwd(), "outputs", "mock", "inbox.jsonl");

async function sendMail({ to, subject, html, text }) {
  if (config.proxmox.mock || !transporter) {
    fs.mkdirSync(path.dirname(INBOX), { recursive: true });
    fs.appendFileSync(INBOX, JSON.stringify({ at: new Date().toISOString(), to, subject }) + "\n");
    console.log(`[email:mock] -> ${to} :: ${subject}`);
    return { mocked: true };
  }
  return transporter.sendMail({ from: config.smtp.from, to, subject, html, text });
}

module.exports = { sendMail };
