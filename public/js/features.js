/**
 * features.js — extension layer wired on top of app.js via window.App.
 *
 * Bridges new UIs (2FA, recovery, sessions, blocks, change username,
 * link previews, polls, accent / wallpaper, TTL, shortcuts) to the existing
 * server protocol. Uses the message types already implemented in
 * websocket/handler.js (totp_setup, list_sessions, list_blocks, recover, ...).
 */
(function () {
  "use strict";
  if (!window.App) {
    console.warn("[features] window.App not ready");
    return;
  }
  var App = window.App;
  var T = function (k, d) { return (window.I18n && window.I18n.t) ? (window.I18n.t(k) || d || k) : (d || k); };
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
    });
  }
  window.AppEscape = escapeHtml;

  function showModal(id) {
    var m = $("#" + id);
    if (m) { m.classList.remove("hidden"); m.setAttribute("aria-hidden", "false"); }
  }
  function hideModal(id) {
    var m = $("#" + id);
    if (m) { m.classList.add("hidden"); m.setAttribute("aria-hidden", "true"); }
  }

  // ======= Accent color + wallpaper =======
  var ACCENTS = [
    { id: "blue", h: 217 },
    { id: "teal", h: 175 },
    { id: "green", h: 142 },
    { id: "orange", h: 24 },
    { id: "rose", h: 350 },
    { id: "slate", h: 215 },
  ];
  var WALLPAPERS = ["none", "dots", "grid", "aurora", "paper"];

  function applyAccent(h) {
    document.documentElement.style.setProperty("--primary-h", String(h));
    try { localStorage.setItem("pc_accent_h", String(h)); } catch (_) {}
  }
  function applyWallpaper(id) {
    var c = $("#messagesContainer");
    if (c) c.setAttribute("data-wallpaper", id || "none");
    try { localStorage.setItem("pc_wallpaper", id || "none"); } catch (_) {}
  }
  function buildAccentGrid() {
    var holder = $("#accentGrid");
    if (!holder) return;
    holder.innerHTML = "";
    var saved = parseInt(localStorage.getItem("pc_accent_h") || "217", 10);
    ACCENTS.forEach(function (a) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "accent-swatch" + (a.h === saved ? " active" : "");
      b.style.background = "hsl(" + a.h + ", 80%, 55%)";
      b.title = a.id;
      b.setAttribute("aria-label", a.id);
      b.addEventListener("click", function () {
        applyAccent(a.h);
        $$(".accent-swatch", holder).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
      });
      holder.appendChild(b);
    });
  }
  function buildWallpaperGrid() {
    var holder = $("#wallpaperGrid");
    if (!holder) return;
    holder.innerHTML = "";
    var saved = localStorage.getItem("pc_wallpaper") || "none";
    WALLPAPERS.forEach(function (w) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "wallpaper-tile" + (w === "none" ? " none" : "") + (w === saved ? " active" : "");
      b.setAttribute("data-wp", w);
      b.setAttribute("aria-label", w);
      if (w === "none") b.textContent = T("disappearingOff", "None");
      b.addEventListener("click", function () {
        applyWallpaper(w);
        $$(".wallpaper-tile", holder).forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
      });
      if (w === "dots") {
        b.style.backgroundImage = "radial-gradient(circle, rgba(255,255,255,.4) 1px, transparent 1px)";
        b.style.backgroundSize = "10px 10px";
      } else if (w === "grid") {
        b.style.backgroundImage =
          "linear-gradient(rgba(255,255,255,.3) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.3) 1px, transparent 1px)";
        b.style.backgroundSize = "10px 10px";
      } else if (w === "aurora") {
        b.style.background =
          "radial-gradient(at 30% 20%, hsla(217,85%,55%,.45), transparent 60%), radial-gradient(at 70% 80%, hsla(160,75%,45%,.45), transparent 60%) #0a0a0c";
      } else if (w === "paper") {
        b.style.background = "#f7f5ee";
      }
      holder.appendChild(b);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var savedH = parseInt(localStorage.getItem("pc_accent_h") || "217", 10);
    if (!Number.isNaN(savedH)) applyAccent(savedH);
    applyWallpaper(localStorage.getItem("pc_wallpaper") || "none");
    buildWallpaperGrid();

    // Inject accent grid above the wallpaper section (only once).
    var wallTitle = $$(".settings-section h3").find(function (h) {
      return /wallpaper/i.test(h.textContent || "") || h.getAttribute("data-i18n") === "wallpaper";
    });
    if (wallTitle && !$("#accentGrid")) {
      var sec = document.createElement("div");
      sec.className = "settings-section";
      sec.innerHTML =
        '<h3 data-i18n="accentColor">' + T("accentColor", "Accent color") + "</h3>" +
        '<div class="accent-grid" id="accentGrid"></div>';
      var anchor = wallTitle.parentElement;
      anchor.parentElement.insertBefore(sec, anchor);
      buildAccentGrid();
    }

    // Hide poll button — server requires a parent message id; deferred for now.
    var pb = $("#pollBtn"); if (pb) pb.classList.add("hidden");

    // ======= Settings tab switching =======
    var settingsTabs = $$("[data-stab]");
    var settingsPanels = $$("[data-spanel]");
    settingsTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var target = tab.getAttribute("data-stab");
        settingsTabs.forEach(function (t) { t.classList.remove("active"); });
        settingsPanels.forEach(function (p) { p.classList.remove("active"); });
        tab.classList.add("active");
        var panel = $("[data-spanel='" + target + "']");
        if (panel) panel.classList.add("active");
      });
    });
  });

  // ======= 2FA setup =======
  on($("#totpStartBtn"), "click", function () {
    App.send({ type: "totp_setup" });
  });
  on($("#totpEnableBtn"), "click", function () {
    var code = ($("#totpVerifyInput") || {}).value;
    if (!code) return;
    App.send({ type: "totp_enable", token: String(code).trim() });
  });
  on($("#totpDisableBtn"), "click", function () {
    var pwd = prompt(T("currentPassword", "Current password") + ":");
    if (!pwd) return;
    App.send({ type: "totp_disable", password: pwd });
  });
  on($("#copyTotpSecretBtn"), "click", function () {
    var c = $("#totpSecretCode");
    if (c && navigator.clipboard) {
      navigator.clipboard.writeText(c.textContent || "").then(function () {
        App.showToast(T("copied", "Copied"), "success");
      });
    }
  });



  // ======= Forgot password =======
  on($("#forgotLink"), "click", function (e) {
    e.preventDefault();
    showModal("forgotModal");
  });
  on($("#forgotCancel"), "click", function () { hideModal("forgotModal"); });
  on($("#forgotSubmit"), "click", function () {
    var u = ($("#forgotUsername") || {}).value;
    var r = ($("#forgotRecovery") || {}).value;
    var p = ($("#forgotNewPwd") || {}).value;
    if (!u || !r || !p) return App.showToast(T("genericError", "Error"), "error");
    App.send({
      type: "recover",
      username: u.trim(),
      recoveryCode: r.trim(),
      newPassword: p,
    });
  });

  // ======= TOTP login modal =======
  on($("#totpLoginCancel"), "click", function () { hideModal("totpModal"); });
  on($("#totpLoginVerify"), "click", function () {
    var c = ($("#totpLoginInput") || {}).value;
    if (!c) return;
    App.send({ type: "totp_verify", token: String(c).trim() });
  });

  // ======= Change username =======
  on($("#changeUsernameBtn"), "click", function () {
    var v = ($("#newUsernameInput") || {}).value;
    if (!v) return;
    App.send({ type: "change_username", username: v.trim() });
  });

  // ======= Sessions =======
  function renderSessions(list, currentId) {
    var ul = $("#sessionList");
    if (!ul) return;
    ul.innerHTML = "";
    if (!list || !list.length) {
      ul.innerHTML = "<li><small>—</small></li>";
      return;
    }
    list.forEach(function (s) {
      var li = document.createElement("li");
      var meta = document.createElement("div");
      meta.className = "session-meta";
      var label = (s.userAgent || s.user_agent || "device").slice(0, 80);
      var ip = s.ip || s.ip_address || "";
      var lastTs = s.lastActive || s.last_active || s.last_seen;
      var last = lastTs ? new Date(lastTs).toLocaleString() : "";
      var current = s.id === currentId
        ? ' <span class="session-current-tag">' + T("currentSession", "this device") + "</span>"
        : "";
      meta.innerHTML =
        "<strong>" + escapeHtml(label) + current + "</strong>" +
        "<small>" + escapeHtml(ip) + " &middot; " + escapeHtml(last) + "</small>";
      li.appendChild(meta);
      if (s.id !== currentId) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-secondary btn-sm";
        btn.textContent = T("revoke", "Revoke");
        btn.addEventListener("click", function () {
          App.send({ type: "revoke_session", sessionId: s.id });
          setTimeout(function () { App.send({ type: "list_sessions" }); }, 200);
        });
        li.appendChild(btn);
      }
      ul.appendChild(li);
    });
  }
  on($("#refreshSessionsBtn"), "click", function () { App.send({ type: "list_sessions" }); });

  // ======= Blocks =======
  function renderBlocks(list) {
    var ul = $("#blockList");
    if (!ul) return;
    ul.innerHTML = "";
    if (!list || !list.length) {
      ul.innerHTML = "<li><small>—</small></li>";
      return;
    }
    list.forEach(function (b) {
      var li = document.createElement("li");
      li.innerHTML = "<span>" + escapeHtml(b.username || b.code || b.id) + "</span>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-secondary btn-sm";
      btn.textContent = T("unblock", "Unblock");
      btn.addEventListener("click", function () {
        App.send({ type: "unblock_user", userId: b.id });
        setTimeout(function () { App.send({ type: "list_blocks" }); }, 200);
      });
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }
  on($("#refreshBlocksBtn"), "click", function () { App.send({ type: "list_blocks" }); });

  // Auto-refresh sessions / blocks when settings opens.
  on($("#settingsBtn"), "click", function () {
    setTimeout(function () {
      App.send({ type: "list_sessions" });
      App.send({ type: "list_blocks" });
    }, 80);
  });

  // ======= TTL (disappearing messages, UI affordance only) =======
  var TTL_STEPS = [0, 30, 300, 3600, 86400, 604800];
  var ttlIdx = 0;
  function fmtTTL(s) {
    if (!s) return "";
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  on($("#ttlBtn"), "click", function () {
    ttlIdx = (ttlIdx + 1) % TTL_STEPS.length;
    var v = TTL_STEPS[ttlIdx];
    var btn = $("#ttlBtn");
    var badge = $("#ttlBadge");
    if (btn) btn.setAttribute("data-ttl", String(v));
    if (badge) {
      if (v) { badge.textContent = fmtTTL(v); badge.classList.remove("hidden"); }
      else { badge.classList.add("hidden"); }
    }
    if (v) App.showToast(T("disappearingMessage", "Disappearing") + ": " + fmtTTL(v), "info");
  });

  // ======= ws responses =======
  App.on(function (data) {
    if (!data || !data.type) return;
    switch (data.type) {
      case "registered":
        // Reflect totp state.
        var on2 = !!data.totpEnabled;
        var st = $("#totpStatus");
        if (st) st.textContent = on2 ? T("totpStatusOn", "2FA is on.") : T("totpStatusOff", "2FA is off.");
        var startBtn = $("#totpStartBtn");
        var disableBtn = $("#totpDisableBtn");
        if (startBtn) startBtn.classList.toggle("hidden", on2);
        if (disableBtn) disableBtn.classList.toggle("hidden", !on2);

        break;
      case "totp_setup":
        if (data.secret) {
          $("#totpSecretCode").textContent = data.secret;
          $("#totpSetup").classList.remove("hidden");
        }
        break;
      case "totp_enabled":
        App.showToast(T("totpStatusOn", "2FA is on."), "success");
        $("#totpSetup").classList.add("hidden");
        $("#totpVerifyInput").value = "";
        var sb = $("#totpStartBtn"); if (sb) sb.classList.add("hidden");
        var db = $("#totpDisableBtn"); if (db) db.classList.remove("hidden");
        var st2 = $("#totpStatus"); if (st2) st2.textContent = T("totpStatusOn", "2FA is on.");
        break;
      case "totp_disabled":
        App.showToast(T("disable", "Disabled"), "success");
        var sb2 = $("#totpStartBtn"); if (sb2) sb2.classList.remove("hidden");
        var db2 = $("#totpDisableBtn"); if (db2) db2.classList.add("hidden");
        var st3 = $("#totpStatus"); if (st3) st3.textContent = T("totpStatusOff", "2FA is off.");
        break;
      case "totp_required":
        showModal("totpModal");
        var inp = $("#totpLoginInput");
        if (inp) { inp.value = ""; setTimeout(function () { inp.focus(); }, 50); }
        break;

      case "recovered":
        hideModal("forgotModal");
        App.showToast(T("passwordUpdated", "Password updated"), "success");
        break;
      case "sessions":
        renderSessions(data.sessions || [], data.current);
        break;
      case "blocks_list":
        renderBlocks(data.blocks || []);
        break;
      case "username_changed":
        App.showToast(T("usernameChanged", "Username changed."), "success");
        var u2 = $("#myUsername"); if (u2) u2.textContent = data.username;
        var ni = $("#newUsernameInput"); if (ni) ni.value = "";
        break;
      case "session_revoked":
        App.showToast(T("revoke", "Revoked"), "success");
        break;
      case "link_preview":
        var p = data.preview;
        if (!p || !data.url) return;
        // Append to last received-or-sent bubble as a fallback.
        var last = $("#messagesContainer .message:last-child .bubble");
        if (last && !last.querySelector(".link-preview")) {
          var a = document.createElement("a");
          a.className = "link-preview";
          a.href = data.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.innerHTML =
            (p.image ? '<img src="' + escapeHtml(p.image) + '" alt="" loading="lazy">' : "") +
            '<div class="lp-body">' +
            '<div class="lp-site">' + escapeHtml(p.site || "") + "</div>" +
            '<div class="lp-title">' + escapeHtml(p.title || data.url) + "</div>" +
            '<div class="lp-desc">' + escapeHtml(p.description || "") + "</div>" +
            "</div>";
          last.appendChild(a);
        }
        break;
    }
  });

  // ======= Keyboard shortcuts =======
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === "k") {
      e.preventDefault();
      var sb3 = $("#searchToggleBtn"); if (sb3) sb3.click();
      var si = $("#searchInput"); if (si) si.focus();
    }
    if (e.key === "Escape") {
      $$(".modal:not(.hidden)").forEach(function (m) {
        m.classList.add("hidden");
        m.setAttribute("aria-hidden", "true");
      });
    }
  });
})();
