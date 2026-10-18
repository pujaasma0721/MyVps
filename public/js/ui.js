/* MYVPS billing UI behaviors */
(function () {
  "use strict";

  // ---- Dark mode toggle (persisted) ------------------------------------
  function applyTheme(t) {
    document.documentElement.classList.toggle("dark", t === "dark");
    try { localStorage.setItem("myvps-theme", t); } catch (_e) {}
    var s = document.querySelector("[data-theme-icon]");
    if (s) s.textContent = t === "dark" ? "☀" : "☾";
  }
  var saved = "light";
  try { saved = localStorage.getItem("myvps-theme") || "light"; } catch (_e) {}
  applyTheme(saved);
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-toggle-theme]");
    if (t) {
      saved = saved === "dark" ? "light" : "dark";
      applyTheme(saved);
    }
  });

  // ---- Lightbox for QRIS proof images -----------------------------------
  var lb = document.querySelector(".lightbox");
  if (lb) {
    document.addEventListener("click", function (ev) {
      var trigger = ev.target.closest("[data-lightbox]");
      if (trigger) {
        lb.querySelector("img").src = trigger.getAttribute("data-lightbox");
        lb.querySelector("figcaption span").textContent = trigger.getAttribute("data-caption") || "";
        lb.classList.add("open");
        return;
      }
      if (ev.target.closest(".lightbox")) lb.classList.remove("open");
    });
    var img = lb.querySelector("img");
    img.addEventListener("click", function (ev) {
      ev.stopPropagation();
      img.classList.toggle("zoomed");
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") lb.classList.remove("open");
    });
  }

  // ---- Confirm dialogs --------------------------------------------------
  document.addEventListener("submit", function (ev) {
    var f = ev.target.closest('[data-confirm]');
    if (f && !window.confirm(f.getAttribute("data-confirm"))) ev.preventDefault();
  });

  // ---- Admin live rows polling (real-time VM status) ---------------------
  var liveRows = document.querySelector("[data-live-rows]");
  if (liveRows) {
    var timer = setInterval(function () {
      fetch(liveRows.getAttribute("data-live-rows"), { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.text() : ""; })
        .then(function (html) {
          if (html) liveRows.innerHTML = html;
        })
        .catch(function () {});
    }, 6000);
    // collect garbage timer on navigation
    window.addEventListener("beforeunload", function () { clearInterval(timer); });
  }
})();
