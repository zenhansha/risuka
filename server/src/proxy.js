// Fast "anonymous view" mode, like Startpage's: the server fetches a page, rewrites every URL
// in it to come back through here, strips scripts, and sends plain HTML/CSS the viewer's own
// browser renders. Local rendering means there is no video round-trip, so it feels instant;
// the site sees only this server's IP; and because scripts are removed, nothing from the site
// runs on the viewer's machine. The trade-off is that script-driven sites (YouTube, web apps)
// do not work here — those need the full remote-browser mode.
//
// It is for approved users only: every request carries a session token (the links inside a
// proxied page keep it), so this never becomes an open proxy.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import dns from 'node:dns';
import { isPrivateAddress } from './guard.js';
import { isTrackerHost } from './trackers.js';

const MAX_BYTES = 6_000_000;
const MAX_REDIRECTS = 6;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// A DNS lookup that refuses private / internal addresses, closing the DNS-rebinding gap:
// the socket connects to exactly the address we checked. allowPrivate is for local tests only.
function makeLookup(allowPrivate) {
  return (hostname, options, cb) => {
    const callback = typeof options === 'function' ? options : cb;
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const ok = allowPrivate ? addresses[0] : addresses.find((a) => !isPrivateAddress(a.address));
      if (!ok) return callback(new Error('blocked address'));
      callback(null, ok.address, ok.family);
    });
  };
}

function fetchUpstream(target, { allowPrivate = false, redirectsLeft = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(target);
    } catch {
      return reject(new ProxyError(400, '開けないアドレスです'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new ProxyError(400, 'http と https のページだけ開けます'));
    if (isTrackerHost(url.hostname.toLowerCase())) return reject(new ProxyError(403, 'blocked'));

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup: makeLookup(allowPrivate),
        timeout: 20_000,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          DNT: '1',
        },
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new ProxyError(502, 'リダイレクトが多すぎます'));
          let next;
          try {
            next = new URL(res.headers.location, url).href;
          } catch {
            return reject(new ProxyError(502, 'リダイレクト先が不正です'));
          }
          return resolve(fetchUpstream(next, { allowPrivate, redirectsLeft: redirectsLeft - 1 }));
        }

        const chunks = [];
        let size = 0;
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream =
          enc === 'gzip' ? res.pipe(zlib.createGunzip())
            : enc === 'deflate' ? res.pipe(zlib.createInflate())
              : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
                : res;
        stream.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            stream.destroy();
            reject(new ProxyError(413, 'ページが大きすぎます'));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), finalUrl: url.href }));
        stream.on('error', (e) => reject(e));
      },
    );
    req.on('timeout', () => req.destroy(new ProxyError(504, 'サイトの応答がありません')));
    req.on('error', (e) => reject(e.code === 'ENOTFOUND' ? new ProxyError(502, 'サイトが見つかりません') : e));
    req.end();
  });
}

// ---- rewriting -------------------------------------------------------------------------------

function toAbs(ref, base) {
  try {
    const u = new URL(ref, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function rewriteSrcset(value, base, link) {
  return value
    .split(',')
    .map((part) => {
      const seg = part.trim();
      if (!seg) return '';
      const sp = seg.split(/\s+/);
      const abs = toAbs(sp[0], base);
      if (abs) sp[0] = link(abs);
      return sp.join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

function rewriteCss(css, base, link) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
    if (/^data:/i.test(ref)) return m;
    const abs = toAbs(ref, base);
    return abs ? `url(${q}${link(abs)}${q})` : m;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, ref) => {
    const abs = toAbs(ref, base);
    return abs ? `@import ${q}${link(abs)}${q}` : m;
  });
  return css;
}

const SKIP_TAGS = /<(script|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SELF_SCRIPT = /<script\b[^>]*\/?>/gi;
const ON_ATTR = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const META_REFRESH = /(<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*url=)([^"']+)(["'])/gi;

function detectCharset(headers, head) {
  const ct = String(headers['content-type'] ?? '');
  const m = /charset=([\w-]+)/i.exec(ct);
  if (m) return m[1].toLowerCase();
  const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return mm ? mm[1].toLowerCase() : 'utf-8';
}

function rewriteHtml(buf, headers, base, { nonce, link, token }) {
  let charset = detectCharset(headers, buf.toString('latin1', 0, 2000));
  if (charset === 'utf8') charset = 'utf-8';
  let html;
  try {
    html = new TextDecoder(charset).decode(buf);
  } catch {
    html = buf.toString('utf-8');
  }

  html = html.replace(SKIP_TAGS, '').replace(SELF_SCRIPT, '').replace(ON_ATTR, '').replace(/<base\b[^>]*>/gi, '');

  html = html.replace(/\b(href|src|action|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi, (m, attr, _raw, dq, sq, bare) => {
    const val = dq ?? sq ?? bare ?? '';
    if (!val || /^(#|data:|mailto:|tel:|javascript:|about:)/i.test(val)) return m;
    const abs = toAbs(val, base);
    return abs ? `${attr}="${link(abs)}"` : m;
  });
  html = html.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _raw, dq, sq) => `srcset="${rewriteSrcset(dq ?? sq ?? '', base, link)}"`);
  html = html.replace(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _raw, dq, sq) => `style="${rewriteCss(dq ?? sq ?? '', base, link).replace(/"/g, '&quot;')}"`);
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => `<style${attrs}>${rewriteCss(css, base, link)}</style>`);
  html = html.replace(META_REFRESH, (m, pre, ref, post) => {
    const abs = toAbs(ref, base);
    return abs ? `${pre}${link(abs)}${post}` : m;
  });

  const inject = `<meta name="referrer" content="no-referrer">`
    + `<script nonce="${nonce}">try{parent.postMessage({orbit:"url",url:${JSON.stringify(base)}},"*")}catch(e){}`
    + `document.addEventListener("submit",function(e){try{var f=e.target;if(f&&(f.method||"get").toLowerCase()==="get"){e.preventDefault();`
    + `var u=new URL(f.getAttribute("action")||location.href,${JSON.stringify(base)});new FormData(f).forEach(function(v,k){u.searchParams.set(k,v)});`
    + `location.href="p?u="+encodeURIComponent(u.href)+"&t="+encodeURIComponent(${JSON.stringify(token)})}}catch(_){}} ,true);</script>`;
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + inject);
  else html = inject + html;
  return html;
}

export function createProxy({ config, isAuthed, log = () => {} }) {
  const frameAncestors = [config.publicUrl, ...config.allowedOrigins].filter(Boolean);
  if (config.dev) frameAncestors.push('http://localhost:*', 'http://127.0.0.1:*');

  return async function handle(req, res, url) {
    const token = url.searchParams.get('t') ?? '';
    const target = url.searchParams.get('u') ?? '';
    if (!isAuthed(token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ログインが必要です');
      return;
    }
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('missing url');
      return;
    }
    const link = (abs) => `p?u=${encodeURIComponent(abs)}&t=${encodeURIComponent(token)}`;
    let host = '';
    try { host = new URL(target).hostname; } catch {}
    const common = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    try {
      const up = await fetchUpstream(target, { allowPrivate: config.allowPrivate });
      const ct = String(up.headers['content-type'] ?? '').toLowerCase();
      const looksHtml = ct.includes('text/html') || ct.includes('application/xhtml')
        || (!ct && /^\s*<(!doctype|html)/i.test(up.body.toString('latin1', 0, 200)));

      if (looksHtml) {
        const nonce = Math.random().toString(36).slice(2);
        res.writeHead(200, {
          ...common,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            `default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; `
            + `media-src 'self' data:; form-action 'self'; base-uri 'none'; `
            + `script-src 'nonce-${nonce}'; frame-ancestors ${frameAncestors.join(' ') || "'none'"}`,
        });
        res.end(rewriteHtml(up.body, up.headers, up.finalUrl, { nonce, link, token }));
        return;
      }
      if (ct.includes('text/css')) {
        res.writeHead(200, { ...common, 'Content-Type': 'text/css; charset=utf-8' });
        res.end(rewriteCss(up.body.toString('utf-8'), up.finalUrl, link));
        return;
      }
      const safeTypes = /^(image\/|font\/|audio\/|video\/|application\/(font|octet-stream|pdf))/i;
      res.writeHead(200, { ...common, 'Content-Type': safeTypes.test(ct) ? ct : 'application/octet-stream', 'Content-Disposition': 'inline' });
      res.end(up.body);
    } catch (err) {
      if (err instanceof ProxyError && err.message === 'blocked') { res.writeHead(204).end(); return; }
      const status = err instanceof ProxyError ? err.status : 502;
      if (!(err instanceof ProxyError)) log(`[proxy] ${host}: ${err.message}`);
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" });
      res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:24px;color:#333">`
        + `このページは高速モードで開けませんでした（${err instanceof ProxyError ? err.message : 'サイトに接続できません'}）。`
        + `<br>完全モード（リモート）なら開けることがあります。</body>`);
    }
  };
}

class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
