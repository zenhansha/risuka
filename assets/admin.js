// Orbit admin control panel. app.js calls window.OrbitAdmin.enter(token, id) after an admin
// logs in at the gate; this module runs the whole dashboard from there.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.ORBIT_CONFIG || {};
  const API = (cfg.apiBase || "").replace(/\/+$/, "");
  const KEY = "orbit.admin";

  const SETTING_LABELS = {
    tabsPerUser: "1人あたりのタブ数",
    tabsTotal: "全体のタブ数",
    idleMinutes: "無操作で終了(分)",
    sessionMinutes: "1回の最大時間(分)",
    passwordMinLength: "パスワード最低文字数",
    applyPerHour: "申請の上限(1時間に)",
    pendingMax: "審査待ちの上限",
  };
  const STATUS = { pending: "審査待ち", approved: "承認済み", rejected: "却下" };

  let token = null;
  let filter = "all";
  let refreshTimer = null;
  let last = null; // last overview

  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } },
    set(v) { try { v === null ? sessionStorage.removeItem(KEY) : sessionStorage.setItem(KEY, JSON.stringify(v)); } catch {} },
  };

  async function api(path, body) {
    const res = await fetch(API + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401) { logout(); throw new Error(data.error || "ログインが切れました"); }
    if (!res.ok) throw new Error(data.error || `error ${res.status}`);
    return data;
  }

  function fmt(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------------------------------------------------------------- render
  function render(o) {
    last = o;
    // stats
    const stats = $("admStats");
    stats.textContent = "";
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const a of o.apps) counts[a.status] = (counts[a.status] || 0) + 1;
    const tiles = [
      ["審査待ち", counts.pending],
      ["承認済み", counts.approved],
      ["接続中", o.sessions.length],
      ["タブ", `${o.stats.tabs} / ${o.stats.maxTabs}`],
    ];
    for (const [label, val] of tiles) {
      const t = el("div", "adm-stat");
      t.append(el("b", null, String(val)), el("span", null, label));
      stats.append(t);
    }

    // applications
    $("admAppCount").textContent = `(${o.apps.length})`;
    const rows = o.apps
      .filter((a) => filter === "all" || a.status === filter)
      .sort((a, b) => (a.status === "pending" ? -1 : 0) - (b.status === "pending" ? -1 : 0) || b.createdAt - a.createdAt);
    const tbody = $("admApps").querySelector("tbody");
    tbody.textContent = "";
    for (const a of rows) {
      const tr = el("tr");
      const c1 = el("td");
      c1.append(el("div", "adm-id", a.id));
      c1.append(el("div", "adm-sub", `申請 ${fmt(a.createdAt)}・最終 ${fmt(a.lastLoginAt)}`));
      const c2 = el("td");
      const badge = el("span", `adm-badge ${a.status}`);
      if (a.online) badge.append(el("i", "live"));
      badge.append(document.createTextNode(STATUS[a.status] || a.status));
      c2.append(badge);
      const c3 = el("td");
      const act = el("div", "adm-actions");
      if (a.status !== "approved") act.append(btn("承認", "ok", () => decide(a.appId, "approved")));
      if (a.status !== "rejected") act.append(btn(a.status === "approved" ? "停止" : "却下", "bad", () => decide(a.appId, "rejected")));
      if (a.online) act.append(btn("切断", "", () => disconnect(a.appId)));
      act.append(btn("削除", "", () => decide(a.appId, "delete", true)));
      c3.append(act);
      tr.append(c1, c2, c3);
      tbody.append(tr);
    }
    $("admAppsEmpty").hidden = rows.length > 0;

    // sessions
    $("admSessCount").textContent = `(${o.sessions.length})`;
    const sl = $("admSessions");
    sl.textContent = "";
    for (const s of o.sessions) {
      const row = el("div", "adm-row");
      const left = el("div");
      left.append(el("div", "adm-id", s.id));
      left.append(el("div", "adm-row-meta", `タブ ${s.tabs}・${fmt(s.since)} から`));
      row.append(left, btn("切断", "bad", () => disconnect(s.appId)));
      sl.append(row);
    }
    $("admSessEmpty").hidden = o.sessions.length > 0;

    // admins
    const al = $("admAdmins");
    al.textContent = "";
    for (const ad of o.admins) {
      const row = el("div", "adm-row");
      const left = el("div");
      left.append(el("div", "adm-id", ad.id));
      if (ad.bootstrap) left.append(el("span", "adm-tag", "メイン"));
      else left.append(el("div", "adm-row-meta", `追加 ${fmt(ad.addedAt)}`));
      row.append(left);
      if (!ad.bootstrap) row.append(btn("削除", "bad", () => removeAdmin(ad.id)));
      else row.append(el("span", "adm-row-meta", "削除不可"));
      al.append(row);
    }

    // settings (build once; keep values in sync on refresh without clobbering typing)
    const form = $("admSettings");
    if (!form.dataset.built) {
      for (const [key, label] of Object.entries(SETTING_LABELS)) {
        const range = o.settingRanges[key];
        if (!range) continue;
        const field = el("div", "adm-field");
        const lab = el("label", null, label);
        lab.htmlFor = `set-${key}`;
        const input = el("input");
        input.type = "number";
        input.id = `set-${key}`;
        input.name = key;
        input.min = range.min;
        input.max = range.max;
        input.value = o.settings[key];
        field.append(lab, input, el("span", "range", `${range.min}〜${range.max}`));
        form.append(field);
      }
      form.dataset.built = "1";
    } else if (document.activeElement?.form !== form) {
      for (const [key] of Object.entries(SETTING_LABELS)) {
        const input = $(`set-${key}`);
        if (input) input.value = o.settings[key];
      }
    }
  }

  function btn(label, kind, onClick) {
    const b = el("button", "adm-btn" + (kind ? " " + kind : ""), label);
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await onClick(); } catch (e) { flash($("admSettingsMsg"), e.message, "bad"); }
      finally { b.disabled = false; }
    });
    return b;
  }

  // ---------------------------------------------------------------- actions
  async function load() {
    render(await api("/api/admin/overview"));
  }

  async function decide(appId, decision, confirmFirst) {
    if (confirmFirst && last) {
      const a = last.apps.find((x) => x.appId === appId);
      if (a && !confirmDelete(a.id)) return;
    }
    await api("/api/admin/decide", { appId, decision });
    await load();
  }

  async function disconnect(appId) {
    await api("/api/admin/sessions", { appId });
    await load();
  }

  async function removeAdmin(id) {
    if (!confirmRemoveAdmin(id)) return;
    await api("/api/admin/admins", { action: "remove", id });
    await load();
  }

  // The artifact/app sandbox blocks confirm(); use a tiny inline confirm via the pending flag.
  const pending = new Map();
  function confirmDelete(id) { return askOnce("delete:" + id, `「${id}」を完全に削除します。もう一度押すと実行します。`); }
  function confirmRemoveAdmin(id) { return askOnce("admin:" + id, `管理者「${id}」を削除します。もう一度押すと実行します。`); }
  function askOnce(key, msg) {
    const now = Date.now();
    const at = pending.get(key) || 0;
    if (now - at < 4000) { pending.delete(key); return true; }
    pending.set(key, now);
    flash($("admSettingsMsg"), msg, "bad");
    return false;
  }

  function flash(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.className = "adm-msg inline" + (kind ? " " + kind : "");
    node.hidden = false;
    clearTimeout(node._t);
    node._t = setTimeout(() => { node.textContent = ""; }, 5000);
  }

  // ---------------------------------------------------------------- wiring
  $("admFilter").addEventListener("click", (e) => {
    const b = e.target.closest(".adm-chip");
    if (!b) return;
    filter = b.dataset.f;
    for (const c of $("admFilter").children) c.classList.toggle("on", c === b);
    if (last) render(last);
  });

  $("admAddAdmin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("admNewId").value.trim();
    const password = $("admNewPw").value;
    const msg = $("admAdminMsg");
    if (!id || !password) return flash2(msg, "ID とパスワードを入れてください", "bad");
    try {
      await api("/api/admin/admins", { action: "add", id, password });
      $("admNewId").value = ""; $("admNewPw").value = "";
      flash2(msg, "追加しました", "ok");
      await load();
    } catch (err) { flash2(msg, err.message, "bad"); }
  });

  $("admSettings").addEventListener("submit", async (e) => {
    e.preventDefault();
    const settings = {};
    for (const key of Object.keys(SETTING_LABELS)) {
      const input = $(`set-${key}`);
      if (input) settings[key] = Number(input.value);
    }
    try {
      const r = await api("/api/admin/settings", { settings });
      for (const [k, v] of Object.entries(r.settings)) { const i = $(`set-${k}`); if (i) i.value = v; }
      flash($("admSettingsMsg"), "保存しました", "ok");
    } catch (err) { flash($("admSettingsMsg"), err.message, "bad"); }
  });

  function flash2(node, text, kind) {
    node.textContent = text;
    node.className = "adm-msg" + (kind ? " " + kind : "");
    node.hidden = false;
  }

  $("admRefresh").addEventListener("click", () => load().catch((e) => flash($("admSettingsMsg"), e.message, "bad")));
  $("admLogout").addEventListener("click", logout);

  // ---------------------------------------------------------------- lifecycle
  function startRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden && !$("admin").hidden) load().catch(() => {});
    }, 12000);
  }

  function enter(tok, id) {
    token = tok;
    const sess = store.get();
    store.set({ token: tok, id, exp: (sess && sess.exp) || Date.now() + 12 * 3600 * 1000 });
    $("gate").hidden = true;
    $("world").hidden = true;
    $("admin").hidden = false;
    $("admWho").textContent = id + " としてログイン中";
    document.title = "Orbit Control";
    load().catch((e) => flash($("admSettingsMsg"), e.message, "bad"));
    startRefresh();
  }

  function logout() {
    clearInterval(refreshTimer);
    token = null;
    store.set(null);
    $("admin").hidden = true;
    $("gate").hidden = false;
    document.title = "go";
  }

  window.OrbitAdmin = {
    enter,
    // called by app.js on boot to resume an admin session after a reload
    resume() {
      const s = store.get();
      if (s && s.token && s.exp > Date.now()) { enter(s.token, s.id); return true; }
      if (s) store.set(null);
      return false;
    },
  };
})();
