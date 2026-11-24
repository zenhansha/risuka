// Remote browser sessions.
//
// One Chromium process is shared. Each signed-in user gets their own incognito BrowserContext,
// which is thrown away (cookies, cache, storage and all) when they disconnect. Each tab is a
// Page in that context. The active tab streams JPEG frames through the DevTools screencast,
// and mouse / keyboard input is replayed into the page.
import { chromium } from 'playwright';

const FRAME = 1; // binary message type: [1][tabId uint32 BE][jpeg bytes]
const MAX_BUFFERED = 1_500_000; // bytes waiting on the socket before frames are skipped

export class BrowserHub {
  constructor({ proxyServer, limits, screen, log = console.log }) {
    this.proxyServer = proxyServer;
    this.limits = limits;
    this.screen = screen;
    this.log = log;
    this.browser = null;
    this.sessions = new Map(); // userKey -> Session
    this.userAgent = null;
  }

  async start() {
    this.browser = await chromium.launch({
      headless: true,
      proxy: { server: this.proxyServer },
      args: [
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--no-first-run',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });
    const major = this.browser.version().split('.')[0];
    // A plain desktop Chrome user agent: "HeadlessChrome" gets blocked by many sites.
    this.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    this.browser.on('disconnected', () => this.log('[browser] chromium exited'));
    return this;
  }

  totalTabs() {
    let n = 0;
    for (const s of this.sessions.values()) n += s.tabs.size;
    return n;
  }

  /** Opens a session for a user. A second connection for the same user replaces the first. */
  async open(userKey, ws, { width, height }) {
    const old = this.sessions.get(userKey);
    if (old) await old.close('replaced');
    const session = new Session(this, userKey, ws);
    this.sessions.set(userKey, session);
    try {
      await session.init(width, height);
    } catch (err) {
      this.sessions.delete(userKey);
      throw err;
    }
    return session;
  }

  async stop() {
    await Promise.all([...this.sessions.values()].map((s) => s.close('shutdown')));
    await this.browser?.close();
  }
}

class Session {
  constructor(hub, userKey, ws) {
    this.hub = hub;
    this.userKey = userKey;
    this.ws = ws;
    this.context = null;
    this.tabs = new Map(); // tabId -> Tab
    this.byPage = new Map(); // Page -> Tab
    this.nextTabId = 1;
    this.activeId = null;
    this.size = { width: 1280, height: 800 };
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.closed = false;
    this.creating = false;
    this.timer = null;
  }

  async init(width, height) {
    this.size = clampSize(width, height, this.hub.screen);
    this.context = await this.hub.browser.newContext({
      viewport: this.size,
      userAgent: this.hub.userAgent,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      acceptDownloads: false,
      serviceWorkers: 'block',
      deviceScaleFactor: 1,
      permissions: [],
      extraHTTPHeaders: { DNT: '1', 'Sec-GPC': '1' },
    });
    this.context.on('page', (page) => this.adopt(page));
    this.timer = setInterval(() => this.checkTimeouts(), 15_000);
    this.send({
      t: 'hello',
      limits: {
        tabsPerUser: this.hub.limits.tabsPerUser,
        idleMinutes: Math.round(this.hub.limits.idleMs / 60_000),
        sessionMinutes: Math.round(this.hub.limits.sessionMs / 60_000),
      },
      endsAt: this.startedAt + this.hub.limits.sessionMs,
    });
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  toast(text, level = 'info') {
    this.send({ t: 'toast', text, level });
  }

  touch() {
    this.lastActivity = Date.now();
  }

  checkTimeouts() {
    const now = Date.now();
    if (now - this.lastActivity > this.hub.limits.idleMs) this.close('idle');
    else if (now - this.startedAt > this.hub.limits.sessionMs) this.close('time');
  }

  canOpenTab() {
    if (this.tabs.size >= this.hub.limits.tabsPerUser) return `タブは ${this.hub.limits.tabsPerUser} 個までです`;
    if (this.hub.totalTabs() >= this.hub.limits.tabsTotal) return 'サーバーが混んでいます。ほかのタブを閉じてから試してください';
    return null;
  }

  adopt(page) {
    if (this.byPage.has(page)) return this.byPage.get(page);
    const reason = this.canOpenTab();
    if (reason) {
      // Popups beyond the limit are closed straight away.
      page.close().catch(() => {});
      this.toast(reason, 'warn');
      return null;
    }
    const tab = new Tab(this, this.nextTabId++, page);
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    tab.wire();
    this.send({ t: 'tab-open', tab: tab.info() });
    // Popups opened by a page become the active tab, like a normal browser.
    if (!this.creating) this.activate(tab.id).catch(() => {});
    return tab;
  }

  async newTab(url) {
    const reason = this.canOpenTab();
    if (reason) {
      this.toast(reason, 'warn');
      return;
    }
    this.creating = true;
    let page;
    try {
      page = await this.context.newPage();
    } finally {
      this.creating = false;
    }
    const tab = this.adopt(page);
    if (!tab) return;
    await this.activate(tab.id);
    if (url) await tab.navigate(url);
  }

  async activate(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (this.activeId === tabId && tab.streaming) return;
    const prev = this.tabs.get(this.activeId);
    this.activeId = tabId;
    if (prev && prev !== tab) await prev.stopStream();
    await tab.page.bringToFront().catch(() => {});
    await tab.startStream();
    this.send({ t: 'tab-active', id: tabId });
  }

  async closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    await tab.page.close().catch(() => {});
    // The 'close' handler on the page does the bookkeeping.
  }

  forget(tab) {
    this.tabs.delete(tab.id);
    this.byPage.delete(tab.page);
    this.send({ t: 'tab-close', id: tab.id });
    if (this.activeId === tab.id) {
      this.activeId = null;
      const next = [...this.tabs.keys()].pop();
      if (next !== undefined) this.activate(next).catch(() => {});
    }
  }

  async resize(width, height) {
    this.size = clampSize(width, height, this.hub.screen);
    await Promise.all([...this.tabs.values()].map((t) => t.page.setViewportSize(this.size).catch(() => {})));
    const active = this.tabs.get(this.activeId);
    if (active) {
      await active.stopStream();
      await active.startStream();
    }
  }

  async handle(msg) {
    if (msg.t !== 'ping') this.touch(); // keep-alive pings are not user activity
    const tab = this.tabs.get(msg.tab ?? this.activeId);
    switch (msg.t) {
      case 'new-tab': return this.newTab(typeof msg.url === 'string' ? msg.url : '');
      case 'activate': return this.activate(msg.tab);
      case 'close-tab': return this.closeTab(msg.tab);
      case 'resize': return this.resize(msg.w, msg.h);
      case 'ping': return this.send({ t: 'pong' });
    }
    if (!tab) return;
    switch (msg.t) {
      case 'navigate': return tab.navigate(msg.url);
      case 'back': return tab.page.goBack({ waitUntil: 'commit', timeout: 20_000 }).catch(() => {});
      case 'forward': return tab.page.goForward({ waitUntil: 'commit', timeout: 20_000 }).catch(() => {});
      case 'reload': return tab.page.reload({ waitUntil: 'commit', timeout: 20_000 }).catch(() => {});
      case 'stop': return tab.cdp?.send('Page.stopLoading').catch(() => {});
      case 'mouse': return tab.mouse(msg);
      case 'wheel': return tab.wheel(msg);
      case 'key': return tab.key(msg);
      case 'text': return tab.text(msg.text);
      case 'copy': return tab.copySelection();
    }
  }

  async close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.hub.sessions.get(this.userKey) === this) this.hub.sessions.delete(this.userKey);
    this.send({ t: 'bye', reason });
    try {
      this.ws.close(4000, reason);
    } catch {}
    // Closing the context deletes every cookie, cache entry and storage it held.
    await this.context?.close().catch(() => {});
  }
}

class Tab {
  constructor(session, id, page) {
    this.session = session;
    this.id = id;
    this.page = page;
    this.cdp = null;
    this.streaming = false;
    this.loading = false;
    this.title = '';
    this.url = page.url();
    this.history = { back: false, forward: false };
  }

  info() {
    return { id: this.id, url: this.url, title: this.title, loading: this.loading, ...this.history };
  }

  sendMeta() {
    this.session.send({ t: 'tab-meta', tab: this.info() });
  }

  wire() {
    const { page } = this;
    page.on('close', () => this.session.forget(this));
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      // Chromium's own error page is shown to the user as an empty tab (the reason comes as a toast).
      this.url = frame.url().startsWith('chrome-error:') ? 'about:blank' : frame.url();
      this.loading = !this.url.startsWith('about:'); // about:blank never fires a later "load" we can rely on
      this.refreshMeta();
    });
    page.on('domcontentloaded', () => this.refreshMeta());
    page.on('load', () => {
      this.loading = false;
      this.refreshMeta();
    });
    page.on('dialog', (dialog) => {
      this.session.toast(`ページからのメッセージ: ${dialog.message().slice(0, 200)}`);
      dialog.dismiss().catch(() => {});
    });
    page.on('crash', () => this.session.toast('このタブがクラッシュしました。再読み込みしてください', 'warn'));
    page.on('filechooser', () => this.session.toast('ファイルのアップロードには対応していません', 'warn'));
    page.on('download', (d) => {
      d.cancel().catch(() => {});
      this.session.toast('ダウンロードには対応していません', 'warn');
    });
  }

  async refreshMeta() {
    try {
      this.title = await this.page.title();
    } catch {}
    try {
      const cdp = await this.ensureCdp();
      const h = await cdp.send('Page.getNavigationHistory');
      this.history = { back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1 };
    } catch {}
    this.sendMeta();
  }

  async ensureCdp() {
    if (!this.cdp) {
      this.cdp = await this.session.context.newCDPSession(this.page);
      this.cdp.on('Page.screencastFrame', (f) => this.onFrame(f));
    }
    return this.cdp;
  }

  async navigate(raw) {
    const url = toUrl(raw);
    if (!url) {
      this.session.toast('開けるのは http:// と https:// のページだけです', 'warn');
      return;
    }
    this.url = url;
    this.loading = true;
    this.sendMeta();
    try {
      await this.page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    } catch (err) {
      this.loading = false;
      this.url = this.page.url().startsWith('chrome-error:') ? 'about:blank' : this.page.url();
      this.sendMeta();
      const msg = String(err.message || err);
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_UNSAFE_PORT|ERR_HTTP_RESPONSE_CODE_FAILURE|403/.test(msg)) {
        this.session.toast('このアドレスは開けません(内部ネットワークや禁止されたポート)', 'warn');
      } else if (/ERR_NAME_NOT_RESOLVED/.test(msg)) {
        this.session.toast('サイトが見つかりません。アドレスを確かめてください', 'warn');
      } else if (/Timeout/.test(msg)) {
        this.session.toast('サイトの応答がありません', 'warn');
      } else if (!/ERR_ABORTED|interrupted by another navigation/.test(msg)) {
        this.session.toast('ページを開けませんでした', 'warn');
      }
    }
  }

  async startStream() {
    const cdp = await this.ensureCdp();
    const { width, height } = this.session.size;
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.session.hub.screen.quality,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
    this.streaming = true;
  }

  async stopStream() {
    if (!this.streaming || !this.cdp) return;
    this.streaming = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  onFrame({ data, sessionId }) {
    const ws = this.session.ws;
    if (this.streaming && ws.readyState === 1 && ws.bufferedAmount < MAX_BUFFERED) {
      const jpeg = Buffer.from(data, 'base64');
      const head = Buffer.alloc(5);
      head.writeUInt8(FRAME, 0);
      head.writeUInt32BE(this.id, 1);
      ws.send(Buffer.concat([head, jpeg]));
    }
    // Acknowledge after queueing so Chromium paces itself to the connection.
    this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  }

  async mouse({ type, x, y, button = 'left', clicks = 1, mods = 0 }) {
    const cdp = await this.ensureCdp();
    const kind = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[type];
    if (!kind) return;
    await cdp.send('Input.dispatchMouseEvent', {
      type: kind,
      x: num(x), y: num(y),
      button: type === 'move' ? 'none' : (['left', 'middle', 'right'].includes(button) ? button : 'left'),
      buttons: type === 'down' ? 1 : 0,
      clickCount: Math.min(3, Math.max(0, clicks | 0)),
      modifiers: mods & 15,
    }).catch(() => {});
  }

  async wheel({ x, y, dx = 0, dy = 0 }) {
    const cdp = await this.ensureCdp();
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: num(x), y: num(y), deltaX: clamp(num(dx), -3000, 3000), deltaY: clamp(num(dy), -3000, 3000),
    }).catch(() => {});
  }

  async key({ type, key }) {
    if (typeof key !== 'string' || key.length > 32) return;
    try {
      if (type === 'down') await this.page.keyboard.down(key);
      else if (type === 'up') await this.page.keyboard.up(key);
    } catch {
      // Unknown key names are ignored.
    }
  }

  async text(text) {
    if (typeof text !== 'string' || !text) return;
    await this.page.keyboard.insertText(text.slice(0, 5000)).catch(() => {});
  }

  async copySelection() {
    const text = await this.page.evaluate(() => String(getSelection?.() ?? '')).catch(() => '');
    this.session.send({ t: 'clipboard', text: text.slice(0, 100_000) });
  }
}

export function toUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function clampSize(w, h, screen) {
  return {
    width: clamp(Math.round(num(w) || 1280), 320, screen.maxWidth),
    height: clamp(Math.round(num(h) || 800), 240, screen.maxHeight),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
