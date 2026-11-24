// Orbit front-end: the plain gate, the crossing, and the remote browser on the other side.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const cfg = window.ORBIT_CONFIG || {};
  const API = (cfg.apiBase || "").replace(/\/+$/, "");
  const WS_URL = (API || location.origin).replace(/^http/, "ws") + "/ws";
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sstore = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} },
  };

  async function api(path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new Error("サーバーにつながりません");
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ================================================================== The gate (plain on purpose)
  $("applyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("applyId").value.trim();
    const password = $("applyPw").value;
    const msg = $("applyMsg");
    if (!id || !password) { msg.textContent = "id と password を入れてください"; return; }
    $("applyBtn").disabled = true;
    msg.textContent = "...";
    try {
      await api("/api/apply", { id, password });
      msg.textContent = "success";
      $("applyId").value = "";
      $("applyPw").value = "";
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      $("applyBtn").disabled = false;
    }
  });

  $("goForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("goId").value.trim();
    const password = $("goPw").value;
    const msg = $("goMsg");
    if (!id || !password) { msg.textContent = "id と password を入れてください"; return; }
    $("goBtn").disabled = true;
    msg.textContent = "...";
    try {
      const r = await api("/api/login", { id, password });
      if (r.status === "pending") { msg.textContent = "まだ承認されていません"; return; }
      if (r.status === "rejected") { msg.textContent = "この ID は使えません"; return; }
      msg.textContent = "";
      $("goPw").value = "";
      if (r.status === "admin") { window.OrbitAdmin?.enter(r.token, r.id); return; }
      sstore.set("orbit.session", JSON.stringify({ token: r.token, exp: Date.now() + r.expiresIn }));
      const b = $("goBtn").getBoundingClientRect();
      enterWorld({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      $("goBtn").disabled = false;
    }
  });

  // ================================================================== The crossing
  // Pixels ripple out from the arrow button: a bright front, cyan afterglow, then the void,
  // with faint rings left behind. The void it ends on is exactly the world's background.
  function warp(ox, oy) {
    const cv = $("warp");
    const ctx = cv.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    cv.width = Math.ceil(W * dpr);
    cv.height = Math.ceil(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv.style.transition = "";
    cv.style.opacity = "1";
    cv.hidden = false;

    const cell = W < 700 ? 10 : 12;
    const cols = Math.ceil(W / cell);
    const rows = Math.ceil(H / cell);
    const n = cols * rows;
    const dist = new Float32Array(n);
    const seed = new Float32Array(n);
    let maxD = 0;
    for (let i = 0; i < n; i++) {
      const cx = (i % cols) * cell + cell / 2;
      const cy = Math.floor(i / cols) * cell + cell / 2;
      seed[i] = Math.random();
      dist[i] = Math.hypot(cx - ox, cy - oy) + (seed[i] - 0.5) * cell * 3; // ragged, pixelated edge
      if (dist[i] > maxD) maxD = dist[i];
    }
    const reach = maxD + 160;
    const T = reduceMotion ? 250 : 1750;
    const GLOW = ["#eafcff", "#b8f4ff", "#74e6ff", "#3fa9c7", "#23667f", "#143a4d", "#0b1c2a"];

    return new Promise((resolve) => {
      const t0 = performance.now();
      function frame(now) {
        const p = Math.min(1, (now - t0) / T);
        const r = reach * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2) + 6;
        const voidPath = new Path2D();
        const glow = GLOW.map(() => new Path2D());
        const amber = new Path2D();
        const ring = new Path2D();
        for (let i = 0; i < n; i++) {
          const d = dist[i];
          if (d > r) continue;
          const x = (i % cols) * cell;
          const y = Math.floor(i / cols) * cell;
          voidPath.rect(x, y, cell, cell);
          const k = r - d; // how far behind the wave front this pixel is
          if (k < 110) {
            const level = Math.min(GLOW.length - 1, Math.floor(k / 16 + seed[i] * 1.5));
            if (seed[i] > 0.985 && k < 40) amber.rect(x + 1, y + 1, cell - 2, cell - 2);
            else glow[level].rect(x + 1, y + 1, cell - 2, cell - 2);
          } else if (seed[i] > 0.55 && Math.sin(k / 26 - p * 9) > 0.93) {
            ring.rect(x + 2, y + 2, cell - 4, cell - 4);
          }
        }
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#05070f";
        ctx.fill(voidPath);
        GLOW.forEach((c, j) => { ctx.fillStyle = c; ctx.fill(glow[j]); });
        ctx.fillStyle = "#ffb45e";
        ctx.fill(amber);
        ctx.fillStyle = "rgba(116,230,255,0.22)";
        ctx.fill(ring);
        if (p < 1) requestAnimationFrame(frame);
        else {
          ctx.fillStyle = "#05070f";
          ctx.fillRect(0, 0, W, H);
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  async function enterWorld(origin) {
    // Lay the world out (invisible) first so the remote viewport gets the right size.
    $("world").style.visibility = "hidden";
    $("world").hidden = false;
    setState();
    connect();
    await warp(origin.x, origin.y);
    $("gate").hidden = true;
    $("world").style.visibility = "";
    document.title = "Orbit";
    startField();
    const cv = $("warp");
    cv.style.transition = "opacity 0.5s ease";
    cv.style.opacity = "0";
    await sleep(520);
    cv.hidden = true;
    $("address").focus();
  }

  // ================================================================== The field behind everything
  const field = { raf: 0, last: 0, seeds: null, cols: 0, rows: 0, cell: 16 };

  function sizeField() {
    const cv = $("field");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    cv.width = Math.ceil(W * dpr);
    cv.height = Math.ceil(H * dpr);
    cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    field.cols = Math.ceil(W / field.cell);
    field.rows = Math.ceil(H / field.cell);
    field.seeds = Float32Array.from({ length: field.cols * field.rows }, Math.random);
  }

  function drawField(t) {
    const ctx = $("field").getContext("2d");
    const { cols, rows, cell, seeds } = field;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = W / 2;
    const cy = H / 2;
    const span = Math.hypot(W, H) / 2;
    ctx.clearRect(0, 0, W, H);
    const levels = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (let i = 0; i < seeds.length; i++) {
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      const near = 1 - Math.min(1, Math.hypot(x - cx, y - cy) / span);
      const tw = seeds[i] > 0.93 ? Math.max(0, Math.sin(t / 900 + seeds[i] * 60)) : 0;
      const wave = Math.max(0, Math.sin(Math.hypot(x - cx, y - cy) / 60 - t / 1400)) * near * 0.6;
      const v = near * 0.35 + tw * 0.9 + wave * 0.3;
      const level = v > 0.75 ? 3 : v > 0.45 ? 2 : v > 0.22 ? 1 : 0;
      levels[level].rect(x + cell / 2 - 1, y + cell / 2 - 1, 2, 2);
    }
    ["rgba(116,230,255,0.07)", "rgba(116,230,255,0.16)", "rgba(116,230,255,0.32)", "rgba(200,246,255,0.7)"]
      .forEach((c, j) => { ctx.fillStyle = c; ctx.fill(levels[j]); });
  }

  function startField() {
    cancelAnimationFrame(field.raf);
    sizeField();
    const loop = (t) => {
      // ~20 fps is plenty for a slow shimmer; stop entirely while a page is on screen.
      if (t - field.last > 50) { field.last = t; drawField(t); }
      if (!reduceMotion && $("world").classList.contains("start") && !document.hidden) field.raf = requestAnimationFrame(loop);
    };
    field.raf = requestAnimationFrame(loop);
  }

  window.addEventListener("resize", () => { if (!$("world").hidden) startField(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("world").hidden) startField(); });

  // ================================================================== Browser state
  const canvas = $("screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  const kbd = $("kbd");
  const tabs = new Map();
  let activeId = null;
  let ws = null;
  let session = null;
  let endsAt = 0;
  let clockTimer = null;
  let frameSize = { w: 1, h: 1 };
  let drawing = false;
  let pendingFrame = null;
  let queuedUrl = null; // typed before the remote browser was ready
  let navPending = false; // a navigation was asked for and the server has not confirmed it yet
  let leaving = false;

  const search = (q) => "https://www.startpage.com/do/search?q=" + encodeURIComponent(q);

  function toTarget(text) {
    const s = text.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return "https://" + s;
    if (/^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/.*)?$/i.test(s)) return "http://" + s;
    return search(s);
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function toast(text, level) {
    const el = document.createElement("div");
    el.className = "toast" + (level === "warn" ? " warn" : "");
    el.textContent = text;
    $("toasts").append(el);
    setTimeout(() => el.remove(), 4200);
  }

  function veil(title, text, retry) {
    $("veil").hidden = !title;
    $("veilTitle").textContent = title || "";
    $("veilText").textContent = text || "";
    $("veilBtn").hidden = !retry;
  }

  const isBlank = (url) => !url || url === "about:blank";

  /** Start screen when the active tab is empty; otherwise the address bar docks and the page shows. */
  function setState() {
    const t = tabs.get(activeId);
    const blank = !navPending && (!t || (isBlank(t.url) && !t.loading));
    const world = $("world");
    const wasStart = world.classList.contains("start");
    world.classList.toggle("start", blank);
    world.classList.toggle("browsing", !blank);
    world.classList.toggle("loading", Boolean(navPending || t?.loading));
    if (blank && !wasStart && !world.hidden) startField();
  }

  function render() {
    const t = tabs.get(activeId);
    $("backBtn").disabled = !t?.back;
    $("fwdBtn").disabled = !t?.forward;
    if (document.activeElement !== $("address")) $("address").value = t && !isBlank(t.url) ? t.url : "";
    document.title = t?.title || "Orbit";

    const wrap = $("tabs");
    wrap.textContent = "";
    if (tabs.size > 1) {
      // Phones: one compact switcher ("2/3" cycles through tabs, × closes the current one).
      const ids = [...tabs.keys()];
      const mini = document.createElement("div");
      mini.className = "tab-mini";
      const cycle = document.createElement("button");
      cycle.type = "button";
      cycle.className = "tab-mini-count";
      cycle.setAttribute("aria-label", "次のタブへ");
      cycle.textContent = `${ids.indexOf(activeId) + 1}/${ids.length}`;
      cycle.addEventListener("click", () => send({ t: "activate", tab: ids[(ids.indexOf(activeId) + 1) % ids.length] }));
      const closeCur = document.createElement("button");
      closeCur.type = "button";
      closeCur.className = "ghost";
      closeCur.setAttribute("aria-label", "このタブを閉じる");
      closeCur.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      closeCur.addEventListener("click", () => send({ t: "close-tab", tab: activeId }));
      mini.append(cycle, closeCur);
      wrap.append(mini);

      for (const tab of tabs.values()) {
        const pill = document.createElement("div");
        pill.className = "tab-pill";
        pill.setAttribute("role", "tab");
        pill.setAttribute("aria-selected", String(tab.id === activeId));
        pill.tabIndex = 0;
        pill.title = tab.title || tab.url || "新しいタブ";
        const label = document.createElement("span");
        label.textContent = tab.title || (isBlank(tab.url) ? "新しいタブ" : tab.url.replace(/^https?:\/\/(www\.)?/, ""));
        const x = document.createElement("button");
        x.className = "ghost";
        x.type = "button";
        x.setAttribute("aria-label", "タブを閉じる");
        x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        x.addEventListener("click", (e) => { e.stopPropagation(); send({ t: "close-tab", tab: tab.id }); });
        pill.append(label, x);
        pill.addEventListener("click", () => send({ t: "activate", tab: tab.id }));
        pill.addEventListener("keydown", (e) => { if (e.key === "Enter") send({ t: "activate", tab: tab.id }); });
        wrap.append(pill);
      }
    }
    setState();
  }

  function navigate(text) {
    const url = toTarget(text);
    if (!url) return;
    if (activeId === null || !ws || ws.readyState !== 1) queuedUrl = url;
    else send({ t: "navigate", tab: activeId, url });
    $("address").blur();
    navPending = true;
    render();
    focusPage();
  }

  // ================================================================== Connection
  function resumeSession() {
    let s = null;
    try { s = JSON.parse(sstore.get("orbit.session") || "null"); } catch {}
    if (!s || s.exp < Date.now()) { sstore.set("orbit.session", null); return false; }
    session = s;
    return true;
  }

  function viewportSize() {
    const r = $("stage").getBoundingClientRect();
    return { w: Math.max(320, Math.floor(r.width)), h: Math.max(240, Math.floor(r.height)) };
  }

  function setHud(online) {
    $("hudState").classList.toggle("online", online);
    if (!online) $("hudText").textContent = "LINKING";
    else updateClock();
  }

  function connect() {
    if (!session && !resumeSession()) return;
    leaving = false;
    veil(null);
    setHud(false);
    tabs.clear();
    activeId = null;
    navPending = Boolean(queuedUrl);
    render();
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const { w, h } = viewportSize();
      ws.send(JSON.stringify({ t: "auth", token: session.token, w, h, url: queuedUrl || "" }));
      queuedUrl = null;
    };
    ws.onmessage = (e) => (typeof e.data === "string" ? onMessage(JSON.parse(e.data)) : onFrame(e.data));
    ws.onclose = (e) => {
      ws = null;
      setHud(false);
      if (leaving || $("world").hidden) return;
      if (e.code >= 4000 && e.code <= 4002) return; // explained by the "bye" message
      veil("接続が切れました", "ネットワークを確認して、もう一度つないでください。前のタブは消えています。", true);
    };
  }

  function onMessage(m) {
    switch (m.t) {
      case "hello":
        endsAt = m.endsAt;
        clearInterval(clockTimer);
        clockTimer = setInterval(updateClock, 1000);
        setHud(true);
        veil(null);
        break;
      case "tab-open":
        tabs.set(m.tab.id, m.tab);
        render();
        break;
      case "tab-meta":
        tabs.set(m.tab.id, { ...tabs.get(m.tab.id), ...m.tab });
        if (m.tab.id === activeId && !isBlank(m.tab.url)) navPending = false;
        render();
        break;
      case "tab-active":
        activeId = m.id;
        if (queuedUrl) { send({ t: "navigate", tab: activeId, url: queuedUrl }); queuedUrl = null; }
        render();
        break;
      case "tab-close":
        tabs.delete(m.id);
        if (activeId === m.id) activeId = null;
        if (!tabs.size) send({ t: "new-tab" });
        render();
        break;
      case "toast":
        if (m.level === "warn") navPending = false;
        toast(m.text, m.level);
        render();
        break;
      case "clipboard":
        if (m.text) navigator.clipboard?.writeText(m.text).then(() => toast("コピーしました"), () => toast("コピーできませんでした"));
        break;
      case "bye":
        onBye(m.reason);
        break;
    }
  }

  const BYE = {
    auth: ["もう一度 ID を入れてください", "確認の期限が切れたか、利用が止められました。", false],
    idle: ["しばらく操作がなかったので終了しました", "タブと Cookie は全部消えました。", true],
    time: ["利用時間が終わりました", "もう一度つなげば続けられます。", true],
    replaced: ["別の画面で開かれました", "同じ ID で別の画面から接続されたので、こちらは終了しました。", true],
    revoked: ["利用が止められました", "管理人がこの ID を止めました。", false],
    busy: ["サーバーが混んでいます", "少し待ってから、もう一度つないでください。", true],
    shutdown: ["サーバーが再起動しています", "少し待ってから、もう一度つないでください。", true],
  };

  function onBye(reason) {
    clearInterval(clockTimer);
    const [title, text, retry] = BYE[reason] || ["終了しました", "", true];
    veil(title, text, retry);
    if (reason === "auth" || reason === "revoked") setTimeout(leave, 2600);
  }

  function leave() {
    leaving = true;
    try { ws?.close(); } catch {}
    ws = null;
    session = null;
    clearInterval(clockTimer);
    cancelAnimationFrame(field.raf);
    sstore.set("orbit.session", null);
    tabs.clear();
    activeId = null;
    navPending = false;
    queuedUrl = null;
    $("world").hidden = true;
    $("gate").hidden = false;
    $("goMsg").textContent = "";
    veil(null);
    document.title = "go";
  }

  function updateClock() {
    if (!$("hudState").classList.contains("online")) return;
    const left = Math.max(0, endsAt - Date.now());
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $("hudText").textContent = `ONLINE  ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // ================================================================== Frames
  function onFrame(buf) {
    const view = new DataView(buf);
    if (view.getUint8(0) !== 1 || view.getUint32(1) !== activeId) return;
    pendingFrame = buf.slice(5);
    if (!drawing) drawNext();
  }

  async function drawNext() {
    drawing = true;
    while (pendingFrame) {
      const data = pendingFrame;
      pendingFrame = null;
      try {
        const bmp = await createImageBitmap(new Blob([data], { type: "image/jpeg" }));
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        frameSize = { w: bmp.width, h: bmp.height };
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      } catch {}
    }
    drawing = false;
  }

  // ================================================================== Input
  function toPage(e) {
    const r = canvas.getBoundingClientRect();
    const scale = Math.min(r.width / frameSize.w, r.height / frameSize.h) || 1;
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }
  const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BUTTONS = ["left", "middle", "right"];
  let moveQueued = null;
  let touch = null;

  function focusPage() { kbd.focus({ preventScroll: true }); }

  canvas.addEventListener("pointerdown", (e) => {
    if (activeId === null) return;
    focusPage();
    if (e.pointerType === "touch") {
      touch = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    const p = toPage(e);
    send({ t: "mouse", tab: activeId, type: "down", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", clicks: e.detail || 1, mods: mods(e) });
    e.preventDefault();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (activeId === null) return;
    const p = toPage(e);
    if (e.pointerType === "touch") {
      if (touch && !touch.moved) {
        send({ t: "mouse", tab: activeId, type: "down", x: p.x, y: p.y, button: "left", clicks: 1 });
        send({ t: "mouse", tab: activeId, type: "up", x: p.x, y: p.y, button: "left", clicks: 1 });
      }
      touch = null;
      return;
    }
    send({ t: "mouse", tab: activeId, type: "up", x: p.x, y: p.y, button: BUTTONS[e.button] || "left", clicks: e.detail || 1, mods: mods(e) });
  });

  canvas.addEventListener("pointermove", (e) => {
    if (activeId === null) return;
    if (e.pointerType === "touch") {
      if (!touch || touch.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 8) touch.moved = true;
      if (touch.moved) {
        const p = toPage(e);
        send({ t: "wheel", tab: activeId, x: p.x, y: p.y, dx: (touch.lastX - e.clientX) * 1.5, dy: (touch.lastY - e.clientY) * 1.5 });
      }
      touch.lastX = e.clientX;
      touch.lastY = e.clientY;
      return;
    }
    const first = !moveQueued;
    moveQueued = toPage(e);
    if (first) {
      requestAnimationFrame(() => {
        const p = moveQueued;
        moveQueued = null;
        if (p) send({ t: "mouse", tab: activeId, type: "move", x: p.x, y: p.y });
      });
    }
  });

  canvas.addEventListener("wheel", (e) => {
    if (activeId === null) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    const p = toPage(e);
    send({ t: "wheel", tab: activeId, x: p.x, y: p.y, dx: e.deltaX * unit, dy: e.deltaY * unit });
  }, { passive: false });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Printable text (Japanese IME included) comes through the hidden textarea and is sent as text;
  // special keys and shortcuts are sent as key presses.
  const KEY_ALIASES = { Meta: "Control", OS: "Control", Esc: "Escape", Spacebar: " ", Del: "Delete", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
  const sentDown = new Set();
  const remoteKey = (e) => KEY_ALIASES[e.key] || e.key;

  kbd.addEventListener("keydown", (e) => {
    if (activeId === null || e.isComposing || e.key === "Process" || e.keyCode === 229) return;
    const shortcut = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key.length === 1 && !shortcut) return;
    const lower = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && lower === "v") return;
    if ((e.ctrlKey || e.metaKey) && lower === "c") { send({ t: "copy", tab: activeId }); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (lower === "l" || lower === "t")) return; // handled by the page-level shortcuts
    e.preventDefault();
    const key = remoteKey(e);
    sentDown.add(key);
    send({ t: "key", tab: activeId, type: "down", key });
  });
  kbd.addEventListener("keyup", (e) => {
    const key = remoteKey(e);
    if (!sentDown.has(key)) return;
    sentDown.delete(key);
    send({ t: "key", tab: activeId, type: "up", key });
  });
  kbd.addEventListener("blur", () => {
    for (const key of sentDown) send({ t: "key", tab: activeId, type: "up", key });
    sentDown.clear();
  });
  kbd.addEventListener("input", (e) => {
    if (e.isComposing) return;
    if (e.inputType === "insertText" && e.data) send({ t: "text", tab: activeId, text: e.data });
    kbd.value = "";
  });
  kbd.addEventListener("compositionend", (e) => {
    if (e.data) send({ t: "text", tab: activeId, text: e.data });
    kbd.value = "";
  });
  kbd.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain");
    if (text) send({ t: "text", tab: activeId, text });
  });

  // ================================================================== Controls
  $("omni").addEventListener("submit", (e) => { e.preventDefault(); navigate($("address").value); });
  $("address").addEventListener("focus", () => $("address").select());
  $("backBtn").addEventListener("click", () => send({ t: "back", tab: activeId }));
  $("fwdBtn").addEventListener("click", () => send({ t: "forward", tab: activeId }));
  $("reloadBtn").addEventListener("click", () => send({ t: tabs.get(activeId)?.loading ? "stop" : "reload", tab: activeId }));
  $("newTabBtn").addEventListener("click", () => { send({ t: "new-tab" }); setTimeout(() => $("address").focus(), 400); });
  $("exitBtn").addEventListener("click", leave);
  $("exitBtn2").addEventListener("click", leave);
  $("veilBtn").addEventListener("click", connect);

  document.addEventListener("keydown", (e) => {
    if ($("world").hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "l") { e.preventDefault(); $("address").focus(); }
    else if (mod && k === "t") { e.preventDefault(); $("newTabBtn").click(); }
  });

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!ws || ws.readyState !== 1) return;
      const { w, h } = viewportSize();
      send({ t: "resize", w, h });
    }, 250);
  }).observe($("stage"));

  setInterval(() => send({ t: "ping" }), 25_000);

  // ================================================================== Boot
  if (window.OrbitAdmin?.resume()) {
    // An admin reloaded: the admin panel takes over, nothing else to do.
  } else if (resumeSession()) {
    // Reloaded while signed in: skip the crossing and go straight to the other side.
    $("gate").hidden = true;
    $("world").hidden = false;
    document.title = "Orbit";
    setState();
    startField();
    connect();
  }
})();
