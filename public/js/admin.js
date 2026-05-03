/**
 * Admin console client. Stores ADMIN_TOKEN in sessionStorage only.
 * All requests carry X-Admin-Token; the server verifies via env ADMIN_TOKEN.
 */
(function () {
  "use strict"
  let sessionId = sessionStorage.getItem("sc_admin_session") || ""

  function $(s) { return document.querySelector(s) }
  function api(path, opts) {
    opts = opts || {}
    opts.headers = Object.assign({}, opts.headers || {}, {
      "X-Session-Id": sessionId, "Content-Type": "application/json",
    })
    return fetch(path, opts).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status))
      return r.json()
    })
  }

  function showApp(show) {
    $("#authBox").classList.toggle("hidden", show)
    $("#adminApp").classList.toggle("hidden", !show)
  }
  function showTab(name) {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name))
    document.querySelectorAll('[id^="tab-"]').forEach(el => el.classList.toggle("hidden", el.id !== "tab-" + name))
    if (name === "dash") loadSummary()
    if (name === "reports") loadReports()
    if (name === "users") loadUsers("")
    if (name === "audit") loadAudit()
    if (name === "metrics") loadMetrics()
  }

  async function trySession() {
    try {
      await api("/api/admin/summary")
      sessionStorage.setItem("sc_admin_session", sessionId)
      showApp(true); showTab("dash")
    } catch (e) {
      alert("Auth failed: " + e.message)
      showApp(false)
    }
  }

  $("#adminLogin").addEventListener("click", () => {
    sessionId = $("#adminSession").value.trim()
    if (sessionId) trySession()
  })
  $("#adminSession").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#adminLogin").click() })
  document.querySelectorAll(".nav-btn").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)))
  $("#reportRefresh").addEventListener("click", loadReports)
  $("#userSearch").addEventListener("click", () => loadUsers($("#userQ").value))
  $("#userQ").addEventListener("keydown", (e) => { if (e.key === "Enter") loadUsers($("#userQ").value) })
  $("#auditRefresh").addEventListener("click", loadAudit)

  if (sessionId) trySession()

  async function loadSummary() {
    try {
      const s = await api("/api/admin/summary")
      $("#summaryGrid").innerHTML = [
        ["Utenti Registrati", s.users], ["Messaggi Inviati", s.messages], ["Amicizie Create", s.friendships], ["Segnalazioni Aperte", s.openReports],
      ].map(([l, n]) => '<div class="stat-card"><div class="stat-val">' + n + '</div><div class="stat-label">' + l + '</div></div>').join("")
    } catch (e) { alert(e.message) }
  }

  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])) }

  async function loadReports() {
    const status = $("#reportStatus").value
    const j = await api("/api/admin/reports" + (status ? "?status=" + status : ""))
    const t = $("#reportsTable")
    t.innerHTML = '<thead><tr><th>When</th><th>Reporter</th><th>Target</th><th>Reason</th><th>Details</th><th>Status</th><th></th></tr></thead><tbody></tbody>'
    const tb = t.querySelector("tbody")
    tb.innerHTML = j.reports.map(r => '<tr>' +
      '<td>' + new Date(r.created_at).toLocaleString() + '</td>' +
      '<td>' + escapeHtml(r.reporter_username || r.reporter_id) + '</td>' +
      '<td>' + escapeHtml(r.target_username || r.reported_id) + '</td>' +
      '<td>' + escapeHtml(r.reason) + '</td>' +
      '<td>' + escapeHtml(r.details || "") + '</td>' +
      '<td><span class="pill ' + (r.status === "resolved" ? "success" : "danger") + '">' + escapeHtml(r.status || "open") + '</span></td>' +
      '<td>' + (r.status !== "resolved" ? '<button class="btn-action" data-resolve="' + r.id + '" type="button">Risolvi</button>' : '') + '</td>' +
      '</tr>').join("")
    tb.querySelectorAll("[data-resolve]").forEach(b => b.addEventListener("click", async () => {
      const note = prompt("Resolution note (optional)") || ""
      await api("/api/admin/reports/resolve", { method: "POST", body: JSON.stringify({ id: parseInt(b.dataset.resolve, 10), resolution: note }) })
      loadReports()
    }))
  }

  async function loadUsers(q) {
    const j = await api("/api/admin/users" + (q ? "?q=" + encodeURIComponent(q) : ""))
    const t = $("#usersTable")
    t.innerHTML = '<thead><tr><th>User</th><th>Code</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody></tbody>'
    const tb = t.querySelector("tbody")
    tb.innerHTML = j.users.map(u => {
      const banned = !!u.banned_at
      return '<tr>' +
        '<td>' + escapeHtml(u.username) + '<div style="opacity:.5;font-size:11px">' + escapeHtml(u.id) + '</div></td>' +
        '<td><code>' + escapeHtml(u.code) + '</code></td>' +
        '<td>' + (u.created_at ? new Date(u.created_at).toLocaleDateString() : "—") + '</td>' +
        '<td>' + (banned ? '<span class="pill danger">bannato</span>' : '<span class="pill success">attivo</span>') + '</td>' +
        '<td>' + (banned
          ? '<button class="btn-action" data-unban="' + escapeHtml(u.id) + '" type="button">Sblocca</button>'
          : '<button class="btn-action danger" data-ban="' + escapeHtml(u.id) + '" type="button">Banna</button>') + '</td>' +
        '</tr>'
    }).join("")
    tb.querySelectorAll("[data-ban]").forEach(b => b.addEventListener("click", async () => {
      const reason = prompt("Ban reason?") || ""
      await api("/api/admin/users/ban", { method: "POST", body: JSON.stringify({ targetId: b.dataset.ban, reason }) })
      loadUsers(q)
    }))
    tb.querySelectorAll("[data-unban]").forEach(b => b.addEventListener("click", async () => {
      await api("/api/admin/users/unban", { method: "POST", body: JSON.stringify({ targetId: b.dataset.unban }) })
      loadUsers(q)
    }))
  }

  async function loadAudit() {
    const j = await api("/api/admin/audit?limit=200")
    const t = $("#auditTable")
    t.innerHTML = '<thead><tr><th>When</th><th>User</th><th>Event</th><th>IP</th><th>Meta</th></tr></thead><tbody></tbody>'
    const tb = t.querySelector("tbody")
    tb.innerHTML = j.events.map(e => '<tr>' +
      '<td>' + new Date(e.timestamp).toLocaleString() + '</td>' +
      '<td>' + escapeHtml(e.username || e.user_id || "—") + '</td>' +
      '<td><code>' + escapeHtml(e.event) + '</code></td>' +
      '<td>' + escapeHtml(e.ip || "") + '</td>' +
      '<td><code>' + escapeHtml(e.meta || "") + '</code></td>' +
      '</tr>').join("")
  }

  async function loadMetrics() {
    const j = await api("/api/admin/metrics")
    $("#metricsOut").textContent = JSON.stringify(j, null, 2)
  }
})()
