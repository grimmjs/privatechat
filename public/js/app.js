/**
 * Private Chat — Frontend logic
 *
 * Highlights:
 *  - Username + password auth (multi-device) with persistent session
 *  - WebSocket auto-reconnect with exponential backoff and connection pill
 *  - End-to-end encryption via SecureCrypto
 *  - i18n via window.I18n
 *  - Theme (light / dark / system) + accent color
 *  - Message reactions, reply, edit, delete (for-me / for-everyone)
 *  - In-chat search (client-side filter)
 *  - Settings modal: profile (bio/status), change password, audit log,
 *    GDPR export, account deletion
 */
(function () {
  "use strict";

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
  var T = function (k) { return (window.I18n ? window.I18n.t(k) : k); };

  // ---------- DOM ----------
  var serverView = $("#serverView");
  var serverForm = $("#serverForm");
  var serverInput = $("#serverInput");

  var loginView = $("#loginView");
  var appView = $("#appView");
  var authForm = $("#authForm");
  var usernameInput = $("#usernameInput");
  var passwordInput = $("#passwordInput");
  var passwordToggle = $("#passwordToggle");
  var authSubmitBtn = $("#authSubmitBtn");
  var loginHintEl = $("#loginHint");
  var langSelect = $("#langSelect");
  var authTabs = $all(".auth-tab");

  var myUsernameEl = $("#myUsername");
  var myCodeEl = $("#myCode");
  var myCodeDisplay = $("#myCodeDisplay");
  var myAvatarEl = $("#myAvatar");
  var profileAvatarInput = $("#profileAvatarInput");
  var copyCodeBtn = $("#copyCodeBtn");
  var logoutBtn = $("#logoutBtn");
  var settingsBtn = $("#settingsBtn");

  var addFriendForm = $("#addFriendForm");
  var friendCodeInput = $("#friendCodeInput");

  var friendListEl = $("#friendList");
  var requestListEl = $("#requestList");
  var outgoingListEl = $("#outgoingList");
  var friendCountEl = $("#friendCount");
  var reqCountEl = $("#reqCount");
  var outgoingCountEl = $("#outgoingCount");

  var messagesContainer = $("#messagesContainer");
  var messageForm = $("#messageForm");
  var messageInput = $("#messageInput");
  var fileBtn = $("#fileBtn");
  var fileInput = $("#fileInput");
  var stickerBtn = $("#stickerBtn");
  var stickerPicker = $("#stickerPicker");
  var stickerGrid = $("#stickerGrid");
  var addStickerBtn = $("#addStickerBtn");
  var stickerFileInput = $("#stickerFileInput");
  var stickerModal = $("#stickerModal");
  var stickerCanvas = $("#stickerCanvas");
  var saveStickerBtn = $("#saveStickerBtn");
  var cancelStickerBtn = $("#cancelStickerBtn");

  var peerNameEl = $("#peerName");
  var peerStatusEl = $("#peerStatus");
  var peerAvatarEl = $("#peerAvatar");
  var encIndicator = $("#encIndicator");
  var connectionPill = $("#connectionPill");
  var connectionLabel = $("#connectionLabel");

  var sidebar = $("#sidebar");
  var sidebarOverlay = $("#sidebarOverlay");
  var openSidebarBtn = $("#openSidebarBtn");
  var closeSidebarBtn = $("#closeSidebarBtn");

  var toastEl = $("#toast");
  var typingIndicator = $("#typingIndicator");
  var typingUsernameEl = $("#typingUsername");

  var searchToggleBtn = $("#searchToggleBtn");
  var searchBar = $("#searchBar");
  var searchInput = $("#searchInput");
  var searchCloseBtn = $("#searchCloseBtn");

  var composeContext = $("#composeContext");
  var ctxAuthor = $("#ctxAuthor");
  var ctxText = $("#ctxText");
  var ctxCancelBtn = $("#ctxCancelBtn");

  var settingsModal = $("#settingsModal");
  var settingsCloseBtn = $("#settingsCloseBtn");
  var bioInput = $("#bioInput");
  var statusTextInput = $("#statusTextInput");
  var profileSaveBtn = $("#profileSaveBtn");
  var oldPasswordInput = $("#oldPasswordInput");
  var newPasswordInput = $("#newPasswordInput");
  var changePasswordBtn = $("#changePasswordBtn");
  var auditList = $("#auditList");
  var exportDataBtn = $("#exportDataBtn");
  var deleteAccountBtn = $("#deleteAccountBtn");
  var accentGrid = $("#accentGrid");
  var themeButtons = $all("[data-theme-choice]");

  var reactionPopover = $("#reactionPopover");

  var friendTabCount = $("#friendTabCount");
  var requestTabCount = $("#requestTabCount");

  // ---------- STATE ----------
  var ws = null;
  var me = null;
  var friends = [];
  var requests = [];
  var outgoingRequests = [];
  var activePeerId = null;
  var conversations = new Map(); // peerId -> [messages]
  var typingTimer = null;
  var isTyping = false;
  var isConnecting = false;
  var reconnectAttempts = 0;
  var reconnectTimer = null;
  var authMode = "login";
  var pendingAuth = null;
  var currentTab = "tabFriends";

  var compose = { mode: null, target: null }; // mode: "reply" | "edit"

  var stickers = [];
  try { stickers = JSON.parse(localStorage.getItem("sc_stickers") || "[]"); } catch(e) {}
  var ACCENTS = [220, 260, 280, 320, 0, 20, 40, 140, 170, 200];

  // ---------- I18N ----------
  if (langSelect && window.I18n) {
    langSelect.value = window.I18n.getLang();
    langSelect.addEventListener("change", function () {
      window.I18n.setLang(langSelect.value);
    });
  }

  if (window.I18n) {
    window.I18n.listen(function () {
      renderSidebar();
      updateAuthLabels();
      if (activePeerId) {
        var peer = friends.find(function (f) { return f.id === activePeerId; });
        if (peer) updateChatHeader(peer);
      } else if (peerNameEl) {
        peerNameEl.textContent = T("selectFriend");
      }
    });
  }

  // ---------- THEME ----------
  function getTheme() {
    try { return localStorage.getItem("sc_theme") || "dark"; } catch (e) { return "dark"; }
  }
  function applyTheme(name) {
    var resolved = name;
    if (name === "system") {
      resolved = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", resolved);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "light" ? "#ffffff" : "#0a0a0c");
  }
  function setTheme(name) {
    try { localStorage.setItem("sc_theme", name); } catch (e) {}
    applyTheme(name);
    syncThemeButtons();
  }
  function syncThemeButtons() {
    var current = getTheme();
    themeButtons.forEach(function (b) {
      b.classList.toggle("active", b.dataset.themeChoice === current);
    });
  }
  themeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () { setTheme(btn.dataset.themeChoice); });
  });
  // React to OS theme change when in "system" mode
  try {
    var mql = window.matchMedia("(prefers-color-scheme: light)");
    var onSystemChange = function () { if (getTheme() === "system") applyTheme("system"); };
    mql.addEventListener ? mql.addEventListener("change", onSystemChange) : mql.addListener(onSystemChange);
  } catch (e) {}
  applyTheme(getTheme());
  syncThemeButtons();

  // ---------- ACCENT ----------
  function buildAccentGrid() {
    if (!accentGrid) return;
    accentGrid.innerHTML = "";
    ACCENTS.forEach(function (h) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "accent-swatch";
      b.style.background = "hsl(" + h + ", 70%, 55%)";
      b.dataset.hue = String(h);
      b.setAttribute("aria-label", "Accent " + h);
      b.addEventListener("click", function () {
        document.documentElement.style.setProperty("--primary-h", String(h));
        try { localStorage.setItem("sc_accent_h", String(h)); } catch (e) {}
        accentGrid.querySelectorAll(".accent-swatch").forEach(function (s) { s.classList.remove("active"); });
        b.classList.add("active");
      });
      try {
        if (localStorage.getItem("sc_accent_h") === String(h)) b.classList.add("active");
      } catch (e) {}
      accentGrid.appendChild(b);
    });
  }
  buildAccentGrid();

  // ---------- AUTH TABS ----------
  function setAuthMode(mode) {
    authMode = mode === "register" ? "register" : "login";
    authTabs.forEach(function (t) { t.classList.toggle("active", t.dataset.tab === authMode); });
    updateAuthLabels();
  }
  function updateAuthLabels() {
    if (!authSubmitBtn) return;
    if (authMode === "register") {
      authSubmitBtn.textContent = T("signUp");
      if (loginHintEl) loginHintEl.textContent = T("registerHint");
    } else {
      authSubmitBtn.textContent = T("signIn");
      if (loginHintEl) loginHintEl.textContent = T("loginHint");
    }
  }
  authTabs.forEach(function (t) {
    t.addEventListener("click", function () {
      setAuthMode(t.dataset.tab);
      usernameInput.focus();
    });
  });

  // Password visibility toggle
  if (passwordToggle && passwordInput) {
    passwordToggle.addEventListener("click", function () {
      passwordInput.type = passwordInput.type === "password" ? "text" : "password";
      passwordInput.focus();
    });
  }

  // ---------- SESSION ----------
  function saveSession() {
    if (!me) return;
    try { localStorage.setItem("sc_session", JSON.stringify(me)); } catch (e) {}
    try { sessionStorage.removeItem("sc_session"); } catch (e) {}
  }
  function loadSession() {
    try {
      var data = localStorage.getItem("sc_session") || sessionStorage.getItem("sc_session");
      if (data) { me = JSON.parse(data); return true; }
    } catch (e) {}
    return false;
  }
  function clearSession() {
    try { localStorage.removeItem("sc_session"); } catch (e) {}
    try { sessionStorage.removeItem("sc_session"); } catch (e) {}
  }

  // ---------- OUTBOX ----------
  function saveOutbox(payload) {
    try {
      var outbox = JSON.parse(localStorage.getItem("sc_outbox") || "[]");
      outbox.push(payload);
      localStorage.setItem("sc_outbox", JSON.stringify(outbox));
    } catch (e) {}
  }
  function removeOutbox(clientId) {
    if (!clientId) return;
    try {
      var outbox = JSON.parse(localStorage.getItem("sc_outbox") || "[]");
      var filtered = outbox.filter(function (m) { return m.clientId !== clientId; });
      localStorage.setItem("sc_outbox", JSON.stringify(filtered));
    } catch (e) {}
  }
  function drainOutbox() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      var outbox = JSON.parse(localStorage.getItem("sc_outbox") || "[]");
      outbox.forEach(function (payload) { send(payload); });
    } catch (e) {}
  }

  // ---------- SERVER URL ----------
  function isPackagedApp() {
    try {
      if (window.Capacitor && (window.Capacitor.isNativePlatform || (typeof window.Capacitor.isNative === "boolean" && window.Capacitor.isNative))) {
        return typeof window.Capacitor.isNativePlatform === "function" ? window.Capacitor.isNativePlatform() : !!window.Capacitor.isNative;
      }
    } catch (e) {}
    return /^(capacitor|file):$/.test(location.protocol);
  }
  function getServerBase() {
    if (isPackagedApp()) {
      try { return localStorage.getItem("sc_server_url") || ""; } catch (e) { return ""; }
    }
    return location.origin;
  }
  function setServerBase(url) {
    try { localStorage.setItem("sc_server_url", url); } catch (e) {}
  }
  function buildWsUrl() {
    var base = getServerBase();
    if (!base) return null;
    try {
      var u = new URL(base);
      var proto = u.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + u.host;
    } catch (e) { return null; }
  }

  // ---------- CONNECTION PILL ----------
  function setConnectionState(state) {
    if (!connectionPill) return;
    connectionPill.dataset.state = state;
    var key = state === "connected" ? "connected"
            : state === "connecting" ? "connecting"
            : "disconnected";
    if (connectionLabel) connectionLabel.textContent = T(key);
  }

  // ---------- WEBSOCKET ----------
  function connectWS() {
    if (isConnecting) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    var wsUrl = buildWsUrl();
    if (!wsUrl) { showServerView(); return; }

    isConnecting = true;
    setConnectionState("connecting");
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", function () {
      isConnecting = false;
      reconnectAttempts = 0;
      setConnectionState("connected");
      drainOutbox();
    });

    ws.addEventListener("message", function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(data);
    });

    ws.addEventListener("close", function () {
      isConnecting = false;
      setConnectionState("disconnected");
      if (me) {
        var delay = Math.min(30000, 1000 * Math.pow(1.6, reconnectAttempts++));
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function () { if (me) connectWS(); }, delay);
      }
    });

    ws.addEventListener("error", function () {
      // close handler will run reconnect
    });
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // Public bridge for extension modules (features.js).
  var __extListeners = [];
  window.App = {
    send: send,
    on: function (cb) { __extListeners.push(cb); },
    getMe: function () { return me; },
    getPeerId: function () { return activePeerId; },
    getFriends: function () { return friends.slice(); },
    showToast: function (m, k) { showToast(m, k || "info"); },
    refreshConnection: function () { try { connectWS(); } catch (_) {} },
  };
  function emitExt(data) {
    for (var i = 0; i < __extListeners.length; i++) {
      try { __extListeners[i](data); } catch (e) {}
    }
  }

  function waitForConnection(callback) {
    if (ws && ws.readyState === WebSocket.OPEN) callback();
    else if (ws && ws.readyState === WebSocket.CONNECTING) ws.addEventListener("open", callback, { once: true });
    else setTimeout(function () { waitForConnection(callback); }, 100);
  }

  // ---------- INCOMING ----------
  async function handleServerMessage(data) {
    if (data.type === "registered") {
      me = { id: data.id, username: data.username, code: data.code, avatar: data.avatar || null };
      saveSession();
      pendingAuth = null;
      showApp();
    } else if (data.type === "avatar_updated") {
      if (me) { me.avatar = data.avatar || null; saveSession(); }
      renderMyAvatar();
      showToast(T("photoUpdated"), "success");
    } else if (data.type === "profile_updated") {
      showToast(T("profileSaved"), "success");
    } else if (data.type === "friends_update") {
      friends = data.friends || [];
      requests = data.requests || [];
      outgoingRequests = data.outgoingRequests || [];
      renderSidebar();
      if (activePeerId) {
        var peer = friends.find(function (f) { return f.id === activePeerId; });
        if (!peer) { activePeerId = null; renderChat(); }
        else { updateChatHeader(peer); }
      }
    } else if (data.type === "message_sent") {
      // Mark our optimistic bubble with server-issued id and delivered status
      finalizeOutgoing(data.clientId, data.id, data.timestamp, data.delivered);
    } else if (data.type === "message") {
      await handleIncomingMessage(data);
    } else if (data.type === "message_edited") {
      await handleIncomingEdit(data);
    } else if (data.type === "message_deleted") {
      handleIncomingDelete(data);
    } else if (data.type === "reaction") {
      handleIncomingReaction(data);
    } else if (data.type === "messages_read") {
      markPeerRead(data.by, data.upToTs);
    } else if (data.type === "sticker") {
      await handleIncomingSticker(data);
    } else if (data.type === "file") {
      await handleIncomingFile(data);
    } else if (data.type === "friend_online") {
      updateFriendStatus(data.userId, true);
    } else if (data.type === "friend_offline") {
      updateFriendStatus(data.userId, false);
    } else if (data.type === "typing") {
      if (data.from === activePeerId) showTypingIndicator(data.fromUsername, data.isTyping);
    } else if (data.type === "info") {
      var map = {
        "Amicizia stabilita!": "friendshipMade",
        "Richiesta inviata": "requestSent",
        "Richiesta accettata": "requestAccepted",
        "Richiesta rifiutata": "requestRejected",
        "Richiesta annullata": "requestCancelled",
        "Password updated": "passwordUpdated",
        "User blocked": "userBlocked",
        "User unblocked": "userUnblocked",
      };
      var key = map[data.message];
      showToast(key ? T(key) : data.message, "success");
    } else if (data.type === "error") {
      pendingAuth = null;
      showToast(data.message || T("genericError"), "error");
    }
    // Always notify extension listeners (features.js) so they can handle
    // new message types like sessions, polls, totp without changing core.
    emitExt(data);
  }

  async function handleIncomingMessage(data) {
    var peerId = data.from;
    // Deduplication
    var conv = conversations.get(peerId);
    if (conv) {
      var exists = conv.find(function (m) { return m.id === data.id || (data.clientId && m.clientId === data.clientId); });
      if (exists) return;
    }
    var ok = await ensureKey(peerId);
    if (!ok) return;
    try {
      var text = await SecureCrypto.decryptString(peerId, data.ciphertext, data.iv);
      addMessage(peerId, {
        id: data.id, from: peerId, fromUsername: data.fromUsername,
        text: text, ts: data.timestamp, isMe: false,
        replyToId: data.replyToId || null,
        ciphertext: data.ciphertext, iv: data.iv,
        reactions: [],
      });
      // Mark as read if conversation is open
      if (peerId === activePeerId) {
        send({ type: "mark_read", peerId: peerId, upToTs: data.timestamp });
      }
    } catch (e) {
      addMessage(peerId, {
        id: data.id, from: peerId, fromUsername: data.fromUsername,
        text: T("friendUndecryptable"), ts: data.timestamp, isMe: false, system: true,
      });
    }
  }
  async function handleIncomingSticker(data) {
    var peerId = data.from;
    var conv = conversations.get(peerId);
    if (conv) {
      var exists = conv.find(function (m) { return m.id === data.id || (data.clientId && m.clientId === data.clientId); });
      if (exists) return;
    }
    var ok = await ensureKey(peerId);
    if (!ok) return;
    try {
      var dec = await SecureCrypto.decryptJSON(peerId, data.ciphertext, data.iv);
      if (dec.sticker) {
        addMessage(peerId, { id: data.id, from: peerId, fromUsername: data.fromUsername, ts: data.timestamp, isMe: false, sticker: dec.sticker });
      }
    } catch (e) {}
  }

  async function handleIncomingFile(data) {
    var peerId = data.from;
    // Deduplication
    var conv = conversations.get(peerId);
    if (conv) {
      var exists = conv.find(function (m) { return m.id === data.id || (data.clientId && m.clientId === data.clientId); });
      if (exists) return;
    }
    var ok = await ensureKey(peerId);
    if (!ok) return;
    try {
      var fileObj = await SecureCrypto.decryptJSON(peerId, data.ciphertext, data.iv);
      addMessage(peerId, { from: peerId, fromUsername: data.fromUsername, ts: data.timestamp, isMe: false, file: fileObj });
    } catch (e) {
      addMessage(peerId, { from: peerId, fromUsername: data.fromUsername, text: T("fileUndecryptable"), ts: data.timestamp, isMe: false, system: true });
    }
  }

  async function handleIncomingEdit(data) {
    var peerId = data.from || (function () {
      // edit may originate from us (ack)
      var list = [...conversations.values()].flat();
      var hit = list.find(function (m) { return m.id === data.id; });
      return hit ? (hit.isMe ? activePeerId : hit.from) : activePeerId;
    })();
    var conv = conversations.get(peerId) || conversations.get(activePeerId);
    if (!conv) return;
    var msg = conv.find(function (m) { return m.id === data.id; });
    if (!msg) return;
    try {
      var text = msg.isMe
        ? await SecureCrypto.decryptString(peerId, data.ciphertext, data.iv)
        : await SecureCrypto.decryptString(peerId, data.ciphertext, data.iv);
      msg.text = text;
      msg.editedAt = data.editedAt;
      msg.ciphertext = data.ciphertext;
      msg.iv = data.iv;
    } catch (e) {
      msg.text = T("friendUndecryptable");
    }
    if (peerId === activePeerId) renderChat();
  }

  function handleIncomingDelete(data) {
    var peerId = data.from || activePeerId;
    var conv = conversations.get(peerId) || conversations.get(activePeerId);
    if (!conv) return;
    var msg = conv.find(function (m) { return m.id === data.id; });
    if (!msg) return;
    if (data.scope === "everyone") {
      msg.deletedAt = Date.now();
      msg.text = T("messageDeleted");
      msg.file = null;
    }
    if (peerId === activePeerId) renderChat();
  }

  function handleIncomingReaction(data) {
    var conv = null, foundPeer = null;
    for (var entry of conversations.entries()) {
      var hit = entry[1].find(function (m) { return m.id === data.id; });
      if (hit) { conv = entry[1]; foundPeer = entry[0]; break; }
    }
    if (!conv) return;
    var msg = conv.find(function (m) { return m.id === data.id; });
    if (!msg) return;
    msg.reactions = msg.reactions || [];
    if (data.action === "remove") {
      msg.reactions = msg.reactions.filter(function (r) {
        return !(r.userId === data.userId && r.emoji === data.emoji);
      });
    } else {
      var exists = msg.reactions.find(function (r) { return r.userId === data.userId && r.emoji === data.emoji; });
      if (!exists) msg.reactions.push({ userId: data.userId, emoji: data.emoji });
    }
    if (foundPeer === activePeerId) renderChat();
  }

  function markPeerRead(byUserId, upToTs) {
    var conv = conversations.get(byUserId);
    if (!conv) return;
    conv.forEach(function (m) { if (m.isMe && m.ts <= upToTs) m.status = "read"; });
    if (byUserId === activePeerId) renderChat();
  }

  function finalizeOutgoing(clientId, serverId, ts, delivered) {
    if (!clientId || !activePeerId) return;
    removeOutbox(clientId);
    var conv = conversations.get(activePeerId);
    if (!conv) return;
    var msg = conv.find(function (m) { return m.clientId === clientId; });
    if (!msg) return;
    msg.id = serverId;
    msg.status = delivered ? "delivered" : "sent";
    if (ts) msg.ts = ts;
    renderChat();
  }

  // ---------- KEY MANAGEMENT ----------
  async function ensureKey(peerId) {
    if (!me) return false;
    if (SecureCrypto.hasKey(peerId)) return true;
    try {
      await SecureCrypto.setAutoKey(peerId, me.id);
      return true;
    } catch (e) {
      console.error("[crypto] auto-key failed", e);
      return false;
    }
  }

  // ---------- UI ----------
  function showApp() {
    if (serverView) serverView.classList.add("hidden");
    if (!me) return;
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    myUsernameEl.textContent = me.username;
    if (myCodeEl) myCodeEl.textContent = me.code;
    myCodeDisplay.textContent = me.code;
    renderMyAvatar();
    document.title = "Private Chat — " + me.username;
  }

  function renderMyAvatar() {
    if (!me) return;
    if (me.avatar) {
      myAvatarEl.innerHTML = "";
      var img = document.createElement("img");
      img.src = me.avatar; img.alt = me.username;
      myAvatarEl.appendChild(img);
    } else {
      myAvatarEl.innerHTML = "";
      var s = document.createElement("span");
      s.id = "myAvatarInitial";
      s.textContent = me.username.slice(0, 1).toUpperCase();
      myAvatarEl.appendChild(s);
    }
  }

  function renderAvatar(el, user) {
    el.innerHTML = "";
    if (user && user.avatar) {
      var img = document.createElement("img");
      img.src = user.avatar;
      img.alt = user.username || "";
      el.appendChild(img);
    } else {
      var initial = (user && user.username ? user.username.slice(0, 1) : "?").toUpperCase();
      var s = document.createElement("span");
      s.textContent = initial;
      el.appendChild(s);
    }
  }

  function renderSidebar() {
    if (friendCountEl) friendCountEl.textContent = friends.length;
    if (friendTabCount) friendTabCount.textContent = friends.length;
    
    friendListEl.innerHTML = friends.length === 0 ? '<li class="empty">' + escapeHtml(T("noFriends")) + "</li>" : "";
    friends.forEach(function (f) {
      var li = document.createElement("li");
      li.className = "friend-item" + (activePeerId === f.id ? " active" : "");
      li.dataset.id = f.id;

      var avatar = document.createElement("div");
      avatar.className = "avatar small";
      renderAvatar(avatar, f);
      li.appendChild(avatar);

      var name = document.createElement("span");
      name.className = "friend-name";
      name.textContent = f.username;
      li.appendChild(name);

      var dot = document.createElement("span");
      dot.className = "online-dot " + (f.online ? "online" : "");
      dot.title = f.online ? T("online") : T("offline");
      li.appendChild(dot);

      li.addEventListener("click", function () { selectPeer(f.id); });
      friendListEl.appendChild(li);
    });

    // Handle Tab Counts
    var totalInvites = requests.length + outgoingRequests.length;
    if (requestTabCount) requestTabCount.textContent = totalInvites;

    reqCountEl && (reqCountEl.textContent = requests.length);
    requestListEl.innerHTML = "";
    if (requests.length > 0) {
      requests.forEach(function (r) {
        var li = document.createElement("li");
        li.className = "request-item";
        var avatar = document.createElement("div");
        avatar.className = "avatar small";
        renderAvatar(avatar, { username: r.fromUsername, avatar: r.fromAvatar });
        li.appendChild(avatar);
        var info = document.createElement("div"); info.className = "req-info";
        var name = document.createElement("div"); name.className = "req-name"; name.textContent = r.fromUsername; info.appendChild(name);
        var code = document.createElement("div"); code.className = "req-code"; code.textContent = r.fromCode; info.appendChild(code);
        li.appendChild(info);
        var actions = document.createElement("div"); actions.className = "req-actions";
        var acceptBtn = document.createElement("button"); acceptBtn.className = "accept"; acceptBtn.dataset.action = "accept"; acceptBtn.dataset.from = r.fromId; acceptBtn.innerHTML = "&#10003;"; actions.appendChild(acceptBtn);
        var rejectBtn = document.createElement("button"); rejectBtn.className = "reject"; rejectBtn.dataset.action = "reject"; rejectBtn.dataset.from = r.fromId; rejectBtn.innerHTML = "&#10007;"; actions.appendChild(rejectBtn);
        li.appendChild(actions);
        requestListEl.appendChild(li);
      });
    }

    outgoingCountEl && (outgoingCountEl.textContent = outgoingRequests.length);
    outgoingListEl.innerHTML = "";
    if (outgoingRequests.length > 0) {
      outgoingRequests.forEach(function (r) {
        var li = document.createElement("li");
        li.className = "request-item pending-outgoing";
        var avatar = document.createElement("div"); avatar.className = "avatar small";
        renderAvatar(avatar, { username: r.toUsername, avatar: r.toAvatar });
        li.appendChild(avatar);
        var info = document.createElement("div"); info.className = "req-info";
        var name = document.createElement("div"); name.className = "req-name"; name.textContent = r.toUsername || "amico"; info.appendChild(name);
        var code = document.createElement("div"); code.className = "req-code"; code.textContent = r.toCode || ""; info.appendChild(code);
        li.appendChild(info);
        var actions = document.createElement("div"); actions.className = "req-actions";
        var cancelBtn = document.createElement("button"); cancelBtn.className = "cancel"; cancelBtn.dataset.action = "cancel"; cancelBtn.dataset.to = r.toId; cancelBtn.innerHTML = "&#10007;"; actions.appendChild(cancelBtn);
        li.appendChild(actions);
        outgoingListEl.appendChild(li);
      });
    }
  }

  // Tab switching logic
  $all(".sidebar-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.dataset.tabTarget;
      $all(".sidebar-tab").forEach(function (t) { t.classList.remove("active"); });
      $all(".sidebar-tab-content").forEach(function (c) { c.classList.add("hidden"); });
      tab.classList.add("active");
      $("#" + target).classList.remove("hidden");
      currentTab = target;
    });
  });

  requestListEl.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "accept") send({ type: "accept_request", fromId: btn.dataset.from });
    else if (btn.dataset.action === "reject") send({ type: "reject_request", fromId: btn.dataset.from });
  });
  outgoingListEl.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "cancel") send({ type: "cancel_request", targetId: btn.dataset.to });
  });

  async function selectPeer(peerId) {
    activePeerId = peerId;
    var peer = friends.find(function (f) { return f.id === peerId; });
    if (!peer) return;
    updateChatHeader(peer);
    renderChat();
    messageForm.classList.remove("hidden");
    messageInput.focus();
    closeSidebar();
    var ok = await ensureKey(peerId);
    if (ok) encIndicator.classList.remove("hidden");
    renderSidebar();
    // Read receipts: when opening a conv, mark messages as read up to now
    send({ type: "mark_read", peerId: peerId, upToTs: Date.now() });
  }

  function updateChatHeader(peer) {
    peerNameEl.textContent = peer.username;
    peerStatusEl.textContent = peer.online ? T("online") : T("offline");
    renderAvatar(peerAvatarEl, peer);
  }

  function updateFriendStatus(userId, isOnline) {
    var friend = friends.find(function (f) { return f.id === userId; });
    if (friend) friend.online = isOnline;
    var li = friendListEl.querySelector('[data-id="' + userId + '"] .online-dot');
    if (li) {
      li.classList.toggle("online", isOnline);
      li.title = isOnline ? T("online") : T("offline");
    }
    if (activePeerId === userId) {
      peerStatusEl.textContent = isOnline ? T("online") : T("offline");
    }
  }

  function renderChat() {
    messagesContainer.innerHTML = "";
    if (!activePeerId) {
      messagesContainer.innerHTML = '<div class="welcome"><h2>' + escapeHtml(T("welcomePeerHeader")) + "</h2><p>" + escapeHtml(T("selectFriendBody")) + "</p></div>";
      messageForm.classList.add("hidden");
      encIndicator.classList.add("hidden");
      return;
    }
    var list = conversations.get(activePeerId) || [];
    var filter = (searchInput && !searchBar.classList.contains("hidden") ? (searchInput.value || "").toLowerCase().trim() : "");
    var filtered = filter ? list.filter(function (m) { return (m.text || "").toLowerCase().includes(filter); }) : list;

    if (filtered.length === 0) {
      var div = document.createElement("div");
      div.className = "bubble system";
      div.textContent = filter ? T("noResults") : T("e2eChat");
      messagesContainer.appendChild(div);
    } else {
      var lastDate = null;
      filtered.forEach(function (m) {
        var d = new Date(m.ts || Date.now());
        var dayKey = d.toDateString();
        if (dayKey !== lastDate) {
          lastDate = dayKey;
          var sep = document.createElement("div");
          sep.className = "date-sep";
          sep.textContent = formatDate(d);
          messagesContainer.appendChild(sep);
        }
        renderBubble(m);
      });
    }
    scrollToBottom();
  }

  function renderBubble(m) {
    if (m.system) {
      var s = document.createElement("div");
      s.className = "bubble system";
      s.textContent = m.text;
      messagesContainer.appendChild(s);
      return;
    }
    var div = document.createElement("div");
    div.className = "bubble " + (m.isMe ? "me" : "other");
    if (m.id) div.dataset.id = m.id;
    if (m.deletedAt) div.classList.add("deleted");

    if (m.replyToId) {
      var conv = conversations.get(activePeerId) || [];
      var orig = conv.find(function (x) { return x.id === m.replyToId; });
      var quote = document.createElement("div");
      quote.className = "reply-quote";
      quote.innerHTML = '<span class="reply-author">' + escapeHtml(orig ? (orig.isMe ? T("tu") : (orig.fromUsername || "")) : "...") + "</span>"
                      + '<span class="reply-text">' + escapeHtml(orig ? (orig.text || "[file]") : "...") + "</span>";
      div.appendChild(quote);
    }

    if (m.sticker) {
      div.classList.add("sticker-msg");
      var img = document.createElement("img");
      img.src = m.sticker;
      div.appendChild(img);
    } else if (m.file) {
      var wrap = document.createElement("div");
      wrap.className = "file-attachment";
      var f = m.file;
      if (f.type && f.type.startsWith("image/")) {
        var img = document.createElement("img");
        img.className = "preview"; img.src = f.dataUrl; img.alt = f.name || "image";
        img.addEventListener("click", function () { window.open(f.dataUrl, "_blank"); });
        wrap.appendChild(img);
      }
      var link = document.createElement("a");
      link.className = "file-link"; link.href = f.dataUrl; link.download = f.name;
      link.textContent = f.name + " (" + formatSize(f.size || 0) + ")";
      wrap.appendChild(link);
      div.appendChild(wrap);
    }
    if (m.text) {
      var p = document.createElement("div");
      p.className = "bubble-text";
      p.textContent = m.text;
      div.appendChild(p);
    }

    var meta = document.createElement("div");
    meta.className = "meta";
    var metaText = (m.isMe ? T("tu") : (m.fromUsername || "")) + " · " + formatTime(m.ts);
    if (m.editedAt && !m.deletedAt) metaText += " · " + T("edited");
    meta.textContent = metaText;
    if (m.isMe && !m.deletedAt) {
      var tick = document.createElement("span");
      tick.className = "msg-status " + (m.status || "sent");
      tick.textContent = m.status === "read" ? "✓✓" : (m.status === "delivered" ? "✓✓" : "✓");
      tick.title = T(m.status || "sent");
      meta.appendChild(document.createTextNode(" "));
      meta.appendChild(tick);
    }
    div.appendChild(meta);

    if (m.reactions && m.reactions.length) {
      var rWrap = document.createElement("div");
      rWrap.className = "reactions";
      var counts = {};
      m.reactions.forEach(function (r) { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
      Object.keys(counts).forEach(function (e) {
        var tag = document.createElement("button");
        tag.className = "reaction-tag";
        tag.type = "button";
        tag.dataset.emoji = e;
        tag.dataset.id = m.id || "";
        tag.textContent = e + " " + counts[e];
        rWrap.appendChild(tag);
      });
      div.appendChild(rWrap);
    }

    // Long-press / right-click context for reply/edit/delete/react
    div.addEventListener("contextmenu", function (e) { e.preventDefault(); openMessageActions(m, div, e); });
    var pressTimer = null;
    div.addEventListener("touchstart", function (e) {
      pressTimer = setTimeout(function () { openMessageActions(m, div, e.touches[0]); }, 500);
    }, { passive: true });
    div.addEventListener("touchend", function () { clearTimeout(pressTimer); });
    div.addEventListener("touchmove", function () { clearTimeout(pressTimer); });

    messagesContainer.appendChild(div);
  }

  function openMessageActions(m, bubble, ev) {
    if (m.system || m.deletedAt) return;
    if (!m.id) return; // wait for server ack
    var rect = bubble.getBoundingClientRect();
    reactionPopover.style.top = (rect.top - 48 + window.scrollY) + "px";
    reactionPopover.style.left = Math.max(10, rect.left) + "px";
    reactionPopover.dataset.id = String(m.id);
    reactionPopover.dataset.peer = activePeerId || "";
    reactionPopover.classList.remove("hidden");

    // Build extra actions (reply / edit / delete) inline below popover
    var menu = document.getElementById("msgActionsMenu");
    if (menu) menu.remove();
    menu = document.createElement("div");
    menu.id = "msgActionsMenu";
    menu.className = "context-menu";
    menu.style.top = (rect.bottom + 8 + window.scrollY) + "px";
    menu.style.left = Math.max(10, rect.left) + "px";

    var replyBtn = document.createElement("button");
    replyBtn.textContent = T("reply");
    replyBtn.addEventListener("click", function () { startReply(m); closeMessageActions(); });
    menu.appendChild(replyBtn);

    if (m.isMe && m.text) {
      var editBtn = document.createElement("button");
      editBtn.textContent = T("editMessage");
      editBtn.addEventListener("click", function () { startEdit(m); closeMessageActions(); });
      menu.appendChild(editBtn);
    }
    if (m.isMe) {
      var delAllBtn = document.createElement("button");
      delAllBtn.className = "danger";
      delAllBtn.textContent = T("deleteForEveryone");
      delAllBtn.addEventListener("click", function () {
        if (confirm(T("confirmDelete"))) send({ type: "delete_message", id: m.id, scope: "everyone" });
        closeMessageActions();
      });
      menu.appendChild(delAllBtn);
    }
    document.body.appendChild(menu);
  }

  function closeMessageActions() {
    reactionPopover.classList.add("hidden");
    var menu = document.getElementById("msgActionsMenu");
    if (menu) menu.remove();
  }

  document.addEventListener("click", function (e) {
    if (reactionPopover.classList.contains("hidden")) return;
    if (e.target.closest("#reactionPopover") || e.target.closest("#msgActionsMenu") || e.target.closest(".bubble")) return;
    closeMessageActions();
  });

  reactionPopover.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-emoji]");
    if (!btn) return;
    var id = parseInt(reactionPopover.dataset.id, 10);
    if (!id) return;
    send({ type: "react", id: id, emoji: btn.dataset.emoji, action: "add" });
    // Optimistic local update
    var conv = conversations.get(activePeerId) || [];
    var msg = conv.find(function (x) { return x.id === id; });
    if (msg) {
      msg.reactions = msg.reactions || [];
      var exists = msg.reactions.find(function (r) { return r.userId === me.id && r.emoji === btn.dataset.emoji; });
      if (!exists) msg.reactions.push({ userId: me.id, emoji: btn.dataset.emoji });
      renderChat();
    }
    closeMessageActions();
  });

  // Toggle reaction by clicking existing reaction tag
  messagesContainer.addEventListener("click", function (e) {
    var tag = e.target.closest(".reaction-tag");
    if (!tag) return;
    var id = parseInt(tag.dataset.id, 10);
    if (!id) return;
    var conv = conversations.get(activePeerId) || [];
    var msg = conv.find(function (x) { return x.id === id; });
    if (!msg) return;
    var mine = (msg.reactions || []).find(function (r) { return r.userId === me.id && r.emoji === tag.dataset.emoji; });
    var action = mine ? "remove" : "add";
    send({ type: "react", id: id, emoji: tag.dataset.emoji, action: action });
    if (action === "remove") {
      msg.reactions = msg.reactions.filter(function (r) { return !(r.userId === me.id && r.emoji === tag.dataset.emoji); });
    } else {
      msg.reactions.push({ userId: me.id, emoji: tag.dataset.emoji });
    }
    renderChat();
  });

  function startReply(m) {
    compose.mode = "reply"; compose.target = m;
    composeContext.classList.add("active");
    composeContext.dataset.kind = "reply";
    ctxAuthor.textContent = (m.isMe ? T("tu") : (m.fromUsername || ""));
    ctxText.textContent = m.text || "[file]";
    messageInput.focus();
  }

  function startEdit(m) {
    compose.mode = "edit"; compose.target = m;
    composeContext.classList.add("active");
    composeContext.dataset.kind = "edit";
    ctxAuthor.textContent = T("editing");
    ctxText.textContent = m.text || "";
    messageInput.value = m.text || "";
    autoResizeTextarea();
    messageInput.focus();
  }

  function clearCompose() {
    compose.mode = null; compose.target = null;
    composeContext.classList.remove("active");
    composeContext.removeAttribute("data-kind");
  }
  ctxCancelBtn.addEventListener("click", clearCompose);

  function addMessage(peerId, msg) {
    if (!conversations.has(peerId)) conversations.set(peerId, []);
    conversations.get(peerId).push(msg);
    if (peerId === activePeerId) { renderChat(); }
    else { showToast(T("newMessage") + " " + (msg.fromUsername || ""), "success"); }
  }

  function scrollToBottom() {
    requestAnimationFrame(function () { messagesContainer.scrollTop = messagesContainer.scrollHeight; });
  }

  function showTypingIndicator(username, isTypingNow) {
    if (isTypingNow) {
      typingUsernameEl.textContent = username + " " + T("typing");
      typingIndicator.classList.remove("hidden");
    } else {
      typingIndicator.classList.add("hidden");
    }
  }

  function handleTyping() {
    if (!activePeerId || !isTyping) {
      isTyping = true;
      send({ type: "typing", to: activePeerId, isTyping: true });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () {
        isTyping = false;
        send({ type: "typing", to: activePeerId, isTyping: false });
      }, 2000);
    }
  }

  function openSidebar() { console.log("[UI] Opening sidebar"); sidebar.classList.add("open"); if (sidebarOverlay) sidebarOverlay.classList.add("open"); }
  function closeSidebar() { console.log("[UI] Closing sidebar"); sidebar.classList.remove("open"); if (sidebarOverlay) sidebarOverlay.classList.remove("open"); }

  // ---------- HELPERS ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c;
    });
  }
  function formatTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function formatDate(d) {
    var today = new Date(); today.setHours(0,0,0,0);
    var dd = new Date(d); dd.setHours(0,0,0,0);
    var diffDays = Math.round((today - dd) / 86400000);
    if (diffDays === 0) return T("today");
    if (diffDays === 1) return T("yesterday");
    return d.toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
  }
  function formatSize(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  var toastTimer = null;
  function showToast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = "toast " + (kind || "");
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add("hidden"); }, 2800);
  }

  // ---------- AVATAR HANDLING ----------
  function processAvatar(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error("no file"));
      if (!file.type || !file.type.startsWith("image/")) return reject(new Error("not image"));
      if (file.size > 8 * 1024 * 1024) return reject(new Error("too large"));
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("read failed")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("load failed")); };
        img.onload = function () {
          try {
            var size = 256;
            var canvas = document.createElement("canvas");
            canvas.width = size; canvas.height = size;
            var ctx = canvas.getContext("2d");
            var scale = Math.max(size / img.width, size / img.height);
            var sw = size / scale, sh = size / scale;
            var sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
            var dataUrl = canvas.toDataURL("image/jpeg", 0.82);
            if (dataUrl.length > 220000) dataUrl = canvas.toDataURL("image/jpeg", 0.65);
            if (dataUrl.length > 280000) return reject(new Error("still too large"));
            resolve(dataUrl);
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  if (myAvatarEl) myAvatarEl.addEventListener("click", function () { if (profileAvatarInput) profileAvatarInput.click(); });
  if (profileAvatarInput) profileAvatarInput.addEventListener("change", async function () {
    var file = profileAvatarInput.files && profileAvatarInput.files[0];
    profileAvatarInput.value = "";
    if (!file) return;
    try {
      var dataUrl = await processAvatar(file);
      send({ type: "update_avatar", avatar: dataUrl });
    } catch (e) {
      showToast(T("photoTooLarge"), "error");
    }
  });

  // ---------- AUTH SUBMIT ----------
  authForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var username = usernameInput.value.trim();
    var password = passwordInput.value;
    if (!username || !password) return showToast(T("missingFields"), "error");
    if (password.length < 6) return showToast(T("passwordTooShort"), "error");
    pendingAuth = { mode: authMode, username: username, password: password };
    connectWS();
    waitForConnection(function () {
      ws.send(JSON.stringify({
        type: pendingAuth.mode === "register" ? "register" : "login",
        username: pendingAuth.username,
        password: pendingAuth.password,
      }));
    });
  });

  addFriendForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var code = friendCodeInput.value.trim().toUpperCase();
    if (!code) return;
    send({ type: "friend_request", code: code });
    friendCodeInput.value = "";
  });

  copyCodeBtn.addEventListener("click", function () {
    if (!me) return;
    navigator.clipboard.writeText(me.code).then(function () {
      showToast(T("copied"), "success");
    }).catch(function () { showToast(T("copyError"), "error"); });
  });

  if (logoutBtn) logoutBtn.addEventListener("click", function () {
    if (!confirm(T("logoutConfirm"))) return;
    try { if (ws) ws.close(); } catch (e) {}
    ws = null;
    me = null;
    friends = []; requests = []; outgoingRequests = [];
    activePeerId = null;
    conversations.clear();
    clearSession();
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
    usernameInput.value = ""; passwordInput.value = "";
    setAuthMode("login");
    usernameInput.focus();
  });

  // ---------- MESSAGE COMPOSER ----------
  function autoResizeTextarea() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + "px";
  }

  async function sendMessage() {
    var text = messageInput.value.trim();
    if (!text || !activePeerId) return;
    var ok = await ensureKey(activePeerId);
    if (!ok) return showToast(T("cryptoError"), "error");

    try {
      var result = await SecureCrypto.encryptString(activePeerId, text);

      if (compose.mode === "edit" && compose.target && compose.target.id) {
        send({ type: "edit_message", id: compose.target.id, ciphertext: result.ciphertext, iv: result.iv });
        // Optimistic local update
        compose.target.text = text;
        compose.target.editedAt = Date.now();
        renderChat();
      } else {
        var clientId = "c_" + Date.now() + "_" + Math.random().toString(36).slice(2);
        var replyToId = (compose.mode === "reply" && compose.target && compose.target.id) ? compose.target.id : null;
        var payload = { type: "message", to: activePeerId, ciphertext: result.ciphertext, iv: result.iv, clientId: clientId, replyToId: replyToId };
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          send(payload);
        } else {
          saveOutbox(payload);
        }

        addMessage(activePeerId, {
          clientId: clientId, from: me.id, fromUsername: me.username,
          text: text, ts: Date.now(), isMe: true, status: (ws && ws.readyState === WebSocket.OPEN ? "sent" : "pending"),
          replyToId: replyToId, ciphertext: result.ciphertext, iv: result.iv, reactions: [],
        });
      }

      messageInput.value = "";
      autoResizeTextarea();
      send({ type: "typing", to: activePeerId, isTyping: false });
      isTyping = false;
      clearTimeout(typingTimer);
      clearCompose();
    } catch (err) { showToast(T("cryptoError"), "error"); }
  }

  messageForm.addEventListener("submit", function (e) { e.preventDefault(); sendMessage(); });
  messageInput.addEventListener("input", function () { autoResizeTextarea(); handleTyping(); });
  messageInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === "Escape") {
      clearCompose();
    }
  });

  // ---------- FILE UPLOAD ----------
  fileBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", async function () {
    var file = fileInput.files[0];
    fileInput.value = "";
    if (!file || !activePeerId) return;
    if (file.size > 10 * 1024 * 1024) return showToast(T("fileTooLarge"), "error");
    var ok = await ensureKey(activePeerId);
    if (!ok) return showToast(T("cryptoError"), "error");

    try {
      var reader = new FileReader();
      reader.onload = async function () {
        var fileObj = { name: file.name, type: file.type, size: file.size, dataUrl: reader.result };
        try {
          var result = await SecureCrypto.encryptJSON(activePeerId, fileObj);
          var clientId = "c_" + Date.now() + "_" + Math.random().toString(36).slice(2);
          var payload = { type: "file", to: activePeerId, ciphertext: result.ciphertext, iv: result.iv, clientId: clientId };
          
          if (ws && ws.readyState === WebSocket.OPEN) {
            send(payload);
          } else {
            saveOutbox(payload);
          }

          addMessage(activePeerId, { clientId: clientId, from: me.id, fromUsername: me.username, ts: Date.now(), isMe: true, status: (ws && ws.readyState === WebSocket.OPEN ? "sent" : "pending"), file: fileObj });
        } catch (e) { showToast(T("genericError"), "error"); }
      };
      reader.readAsDataURL(file);
    } catch (err) { showToast(T("genericError"), "error"); }
  });

  // ---------- STICKERS ----------
  function renderStickers() {
    stickerGrid.innerHTML = "";
    stickers.forEach(function (url, idx) {
      var div = document.createElement("div");
      div.className = "sticker-item";
      div.innerHTML = '<img src="' + url + '">';
      div.addEventListener("click", function () { sendSticker(url); stickerPicker.classList.remove("visible"); });
      // Context menu to delete
      div.addEventListener("contextmenu", function(e) {
        e.preventDefault();
        if (confirm("Rimuovere questo sticker?")) {
          stickers.splice(idx, 1);
          localStorage.setItem("sc_stickers", JSON.stringify(stickers));
          renderStickers();
        }
      });
      stickerGrid.appendChild(div);
    });
  }
  renderStickers();

  stickerBtn.addEventListener("click", function (e) { e.stopPropagation(); stickerPicker.classList.toggle("visible"); });
  document.addEventListener("click", function (e) {
    if (stickerPicker && !stickerPicker.contains(e.target) && e.target !== stickerBtn && !stickerBtn.contains(e.target)) {
      stickerPicker.classList.remove("visible");
    }
  });

  addStickerBtn.addEventListener("click", function () { stickerFileInput.click(); });
  
  var stickerImg = null;
  stickerFileInput.addEventListener("change", function () {
    var file = stickerFileInput.files[0];
    stickerFileInput.value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      stickerImg = new Image();
      stickerImg.onload = function () {
        stickerModal.classList.remove("hidden");
        drawStickerCrop();
      };
      stickerImg.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  function drawStickerCrop() {
    var ctx = stickerCanvas.getContext("2d");
    var size = 320;
    stickerCanvas.width = size;
    stickerCanvas.height = size;
    
    var iw = stickerImg.width; var ih = stickerImg.height;
    var s = Math.min(iw, ih);
    var sx = (iw - s) / 2; var sy = (ih - s) / 2;
    
    ctx.clearRect(0,0,size,size);
    // Draw rounded square path for cropping if desired, but CSS border-radius on img is cleaner for display.
    // We'll just crop to square here.
    ctx.drawImage(stickerImg, sx, sy, s, s, 0, 0, size, size);
  }

  saveStickerBtn.addEventListener("click", function () {
    var dataUrl = stickerCanvas.toDataURL("image/webp", 0.8);
    stickers.push(dataUrl);
    localStorage.setItem("sc_stickers", JSON.stringify(stickers));
    renderStickers();
    stickerModal.classList.add("hidden");
  });
  cancelStickerBtn.addEventListener("click", function () { stickerModal.classList.add("hidden"); });

  async function sendSticker(dataUrl) {
    if (!activePeerId) return;
    var ok = await ensureKey(activePeerId);
    if (!ok) return;
    try {
      var result = await SecureCrypto.encryptJSON(activePeerId, { sticker: dataUrl });
      var clientId = "s_" + Date.now();
      send({ type: "sticker", to: activePeerId, ciphertext: result.ciphertext, iv: result.iv, clientId: clientId });
      addMessage(activePeerId, { from: me.id, fromUsername: me.username, ts: Date.now(), isMe: true, sticker: dataUrl, clientId: clientId });
    } catch (e) { showToast(T("genericError"), "error"); }
  }

  // Update handleIncomingMessage to support stickers
  var oldHandleIncoming = handleIncomingMessage;
  handleIncomingMessage = async function(data) {
    if (data.type === "sticker") {
      var ok = await ensureKey(data.from);
      if (!ok) return;
      try {
        var dec = await SecureCrypto.decryptJSON(data.from, data.ciphertext, data.iv);
        if (dec.sticker) {
           addMessage(data.from, { id: data.id, from: data.from, fromUsername: data.fromUsername, ts: data.timestamp, isMe: false, sticker: dec.sticker });
        }
      } catch(e) {}
      return;
    }
    return oldHandleIncoming(data);
  };


  // ---------- SEARCH ----------
  if (searchToggleBtn) searchToggleBtn.addEventListener("click", function () {
    if (!activePeerId) return showToast(T("selectFriendFirst"), "error");
    searchBar.classList.toggle("hidden");
    if (!searchBar.classList.contains("hidden")) { searchInput.focus(); }
    else { searchInput.value = ""; renderChat(); }
  });
  if (searchCloseBtn) searchCloseBtn.addEventListener("click", function () {
    searchBar.classList.add("hidden"); searchInput.value = ""; renderChat();
  });
  if (searchInput) searchInput.addEventListener("input", function () { renderChat(); });

  // ---------- SETTINGS MODAL ----------
  function openSettings() {
    settingsModal.classList.remove("hidden");
    settingsModal.setAttribute("aria-hidden", "false");
    syncThemeButtons();
    send({ type: "get_audit" });
  }
  function closeSettings() {
    settingsModal.classList.add("hidden");
    settingsModal.setAttribute("aria-hidden", "true");
  }
  settingsBtn && settingsBtn.addEventListener("click", openSettings);
  settingsCloseBtn && settingsCloseBtn.addEventListener("click", closeSettings);
  settingsModal && settingsModal.addEventListener("click", function (e) {
    if (e.target === settingsModal) closeSettings();
  });

  profileSaveBtn && profileSaveBtn.addEventListener("click", function () {
    send({ type: "update_profile", bio: bioInput.value, status: statusTextInput.value });
  });
  changePasswordBtn && changePasswordBtn.addEventListener("click", function () {
    var oldPwd = oldPasswordInput.value; var newPwd = newPasswordInput.value;
    if (!oldPwd || !newPwd) return showToast(T("missingFields"), "error");
    if (newPwd.length < 6) return showToast(T("passwordTooShort"), "error");
    send({ type: "change_password", oldPassword: oldPwd, newPassword: newPwd });
    oldPasswordInput.value = ""; newPasswordInput.value = "";
  });

  exportDataBtn && exportDataBtn.addEventListener("click", function () {
    if (!me) return;
    var url = "/api/account/export?userId=" + encodeURIComponent(me.id);
    window.open(url, "_blank");
  });

  deleteAccountBtn && deleteAccountBtn.addEventListener("click", async function () {
    if (!me) return;
    var pwd = prompt(T("confirmDeleteAccount"));
    if (!pwd) return;
    try {
      var res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: me.id, password: pwd }),
      });
      var json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      showToast(T("accountDeleted"), "success");
      setTimeout(function () {
        try { if (ws) ws.close(); } catch (e) {}
        clearSession();
        location.reload();
      }, 1000);
    } catch (e) { showToast(e.message, "error"); }
  });

  // ---------- SERVER SETUP ----------
  function showServerView() {
    if (loginView) loginView.classList.add("hidden");
    if (appView) appView.classList.add("hidden");
    if (serverView) {
      serverView.classList.remove("hidden");
      try { serverInput.value = localStorage.getItem("sc_server_url") || ""; } catch (e) {}
    }
  }
  function hideServerView() {
    if (serverView) serverView.classList.add("hidden");
    if (loginView) loginView.classList.remove("hidden");
  }
  if (serverForm) serverForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var raw = (serverInput.value || "").trim();
    if (!raw) return;
    if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
    try {
      var u = new URL(raw);
      var clean = u.protocol + "//" + u.host;
      setServerBase(clean);
      hideServerView();
      if (me) connectWS();
    } catch (err) { showToast("URL non valido", "error"); }
  });

  // ---------- PWA INSTALL PROMPT ----------
  var deferredPrompt = null;
  var installBannerDismissed = localStorage.getItem("pwa-install-dismissed");
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }
  function isInStandaloneMode() {
    return window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true ||
      document.referrer.includes("android-app://");
  }
  function createInstallBanner() {
    if (document.getElementById("installBanner")) return;
    var banner = document.createElement("div");
    banner.id = "installBanner";
    banner.className = "install-banner";
    banner.innerHTML =
      '<div class="app-icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>' +
      '<div class="app-info"><h4>' + escapeHtml(T("installApp")) + "</h4><p>" + escapeHtml(T("installAppDesc")) + "</p></div>" +
      '<button class="install-btn" id="installBtn">' + escapeHtml(T("install")) + "</button>" +
      '<button class="close-banner" id="closeBannerBtn"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
    document.body.appendChild(banner);
    document.getElementById("installBtn").addEventListener("click", function () {
      if (isIOS()) showIOSInstallInstructions();
      else if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function () { deferredPrompt = null; removeInstallBanner(); });
      }
    });
    document.getElementById("closeBannerBtn").addEventListener("click", function () {
      localStorage.setItem("pwa-install-dismissed", "true");
      removeInstallBanner();
    });
  }
  function removeInstallBanner() {
    var banner = document.getElementById("installBanner");
    if (banner) banner.remove();
  }
  function showIOSInstallInstructions() {
    var modal = document.createElement("div");
    modal.id = "iosInstallModal";
    modal.className = "ios-install-modal";
    modal.innerHTML =
      '<div class="ios-install-content">' +
      "<h3>" + escapeHtml(T("iosInstallTitle")) + "</h3>" +
      '<div class="ios-install-steps">' +
      '<div class="ios-step"><span class="step-num">1</span><p>' + T("iosStep1") + "</p></div>" +
      '<div class="ios-step"><span class="step-num">2</span><p>' + T("iosStep2") + "</p></div>" +
      '<div class="ios-step"><span class="step-num">3</span><p>' + T("iosStep3") + "</p></div>" +
      "</div>" +
      '<button class="close-btn" id="closeIOSModal">' + escapeHtml(T("iosUnderstood")) + "</button>" +
      "</div>";
    document.body.appendChild(modal);
    modal.addEventListener("click", function (e) {
      if (e.target === modal || e.target.id === "closeIOSModal") {
        modal.remove();
        localStorage.setItem("pwa-install-dismissed", "true");
        removeInstallBanner();
      }
    });
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (!installBannerDismissed && !isInStandaloneMode()) setTimeout(createInstallBanner, 2000);
  });
  if (isIOS() && !isInStandaloneMode() && !installBannerDismissed) setTimeout(createInstallBanner, 3000);

  if (openSidebarBtn) {
    openSidebarBtn.addEventListener("click", openSidebar);
    openSidebarBtn.addEventListener("touchstart", function(e) { e.preventDefault(); openSidebar(); }, { passive: false });
  }
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener("click", closeSidebar);
    closeSidebarBtn.addEventListener("touchstart", function(e) { e.preventDefault(); closeSidebar(); }, { passive: false });
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener("click", closeSidebar);
    sidebarOverlay.addEventListener("touchstart", function(e) { e.preventDefault(); closeSidebar(); }, { passive: false });
  }

  // Setup profile modal tabs
  $all(".settings-tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = btn.dataset.target;
      $all(".settings-tab-btn").forEach(function (b) { b.classList.remove("active"); });
      $all(".settings-panel").forEach(function (p) { p.classList.add("hidden"); });
      btn.classList.add("active");
      $(target).classList.remove("hidden");
    });
  });

  // Init
  setAuthMode("login");
  updateAuthLabels();

  if (isPackagedApp() && !getServerBase()) {
    showServerView();
  } else if (loadSession()) {
    showApp();
    connectWS();
    waitForConnection(function () {
      ws.send(JSON.stringify({ type: "register", username: me.username, existingId: me.id }));
    });
  }
})();
