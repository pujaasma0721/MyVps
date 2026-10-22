"use strict";
/**
 * Telegram notifier — one-way (optional).
 *
 * Notifs are FIRE-AND-FORGET: a Telegram failure must never break
 * provisioning or credential email. While TELEGRAM_BOT_TOKEN or
 * TELEGRAM_CHAT_ID is empty, this is a no-op (log + return).
 */
const config = require("../config");

async function sendTelegram(text) {
  const token = config.telegram && config.telegram.botToken;
  const chatId = config.telegram && config.telegram.chatId;
  if (!token || !chatId || token === "MISSING-TELEGRAM_BOT_TOKEN" || chatId === "MISSING-TELEGRAM_CHAT_ID") {
    console.log("[telegram] skipped (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset)");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[telegram] send failed:", err.message);
    return false;
  }
}

module.exports = { sendTelegram };
