// Egress guard: a small forward proxy that every request from the remote Chromium goes through.
//
// Why a proxy and not page.route()? route() misses WebSockets, service workers and some
// redirects. Sending all traffic (loopback included) through this proxy means one place decides
// what the remote browser may reach:
//   - no private, loopback, link-local or cloud-metadata addresses (SSRF protection)
//   - no mail or database ports
//   - no known trackers / ad servers
// The proxy resolves DNS itself and connects to the exact address it checked, so a hostname
// cannot flip to 127.0.0.1 between the check and the connection (DNS rebinding).
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isTrackerHost } from './trackers.js';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, bits, 'ipv6');

const BLOCKED_PORTS = new Set([0, 19, 21, 22, 23, 25, 53, 110, 111, 135, 137, 139, 143, 445, 465, 587, 993, 995,
  1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017]);

const BLOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Blocked</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#05070f;color:#e3ecff;font:15px system-ui,sans-serif">
<p>Orbit はこのアドレスへの接続を止めました(内部のネットワークや、使えないポートです)。</p></body>`;

export function isPrivateAddress(ip) {
  let addr = ip;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is really IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1];
  const family = net.isIP(addr);
  if (family === 0) return true; // not an address at all: refuse
  if (family === 6 && /^::ffff:/i.test(addr)) return true; // other mapped forms
  return blocked.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

export function createGuard({ allowPrivate = false, blockTrackers = true, log = () => {} } = {}) {
  const stats = { allowed: 0, blocked: 0 };

  async function resolve(hostname, port) {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!host) throw new GuardError('empty host');
    if (BLOCKED_PORTS.has(port) || port < 1 || port > 65535) throw new GuardError(`port ${port} is not allowed`);
    if (blockTrackers && isTrackerHost(host)) throw new GuardError('tracker', true);
    if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))) {
      throw new GuardError(`${host} is an internal name`);
    }
    let addrs;
    if (net.isIP(host)) addrs = [{ address: host }];
    else {
      try {
        addrs = await dns.lookup(host, { all: true, verbatim: true });
      } catch {
        throw new GuardError(`cannot resolve ${host}`);
      }
    }
    if (!addrs.length) throw new GuardError(`cannot resolve ${host}`);
    if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
      throw new GuardError(`${host} points to a private address`);
    }
    return addrs[0].address;
  }

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP request in absolute form: "GET http://example.com/path HTTP/1.1"
    let url;
    try {
      url = new URL(req.url);
      if (url.protocol !== 'http:') throw new GuardError('only http here');
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const port = Number(url.port || 80);
    let ip;
    try {
      ip = await resolve(url.hostname, port);
    } catch (err) {
      stats.blocked += 1;
      log(`[guard] blocked http ${url.hostname}: ${err.message}`);
      if (err.tracker) res.writeHead(204).end();
      else res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(BLOCKED_PAGE);
      return;
    }
    stats.allowed += 1;
    const headers = { ...req.headers };
    for (const h of Object.keys(headers)) if (h.startsWith('proxy-')) delete headers[h];
    const upstream = http.request(
      { host: ip, port, method: req.method, path: url.pathname + url.search, headers, setHost: false, timeout: 30_000 },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('upstream error');
      else res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS and WebSocket-over-TLS: "CONNECT example.com:443"
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '');
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const [, hostname, portStr] = m;
    const port = Number(portStr);
    let ip;
    try {
      ip = await resolve(hostname, port);
    } catch (err) {
      stats.blocked += 1;
      log(`[guard] blocked connect ${hostname}:${port}: ${err.message}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    stats.allowed += 1;
    const upstream = net.connect({ host: ip, port, timeout: 30_000 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.setTimeout(0);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });

  server.on('clientError', (_err, socket) => socket.destroy());

  return {
    stats,
    resolve,
    async listen() {
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}

export class GuardError extends Error {
  constructor(message, tracker = false) {
    super(message);
    this.tracker = tracker;
  }
}
