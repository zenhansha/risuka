// Domains of common trackers and ad servers. A request to one of these (or any subdomain)
// is dropped by the egress guard. Keep this list short and obvious: blocking a domain a site
// needs for its content breaks the site.
const TRACKERS = [
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'googletagservices.com',
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'connect.facebook.net', 'pixel.facebook.com', 'analytics.twitter.com', 'ads-twitter.com',
  'analytics.tiktok.com', 'bat.bing.com', 'clarity.ms', 'hotjar.com', 'hotjar.io',
  'scorecardresearch.com', 'quantserve.com', 'criteo.com', 'criteo.net', 'taboola.com',
  'outbrain.com', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
  'amazon-adsystem.com', 'adsrvr.org', 'moatads.com', 'chartbeat.com', 'chartbeat.net',
  'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com', 'fullstory.com',
  'newrelic.com', 'nr-data.net', 'branch.io', 'app-measurement.com', 'yandex.ru/metrika',
  'mc.yandex.ru', 'ad.yieldmanager.com', 'i-mobile.co.jp', 'microad.jp', 'socdm.com',
  'ladsp.com', 'adingo.jp', 'impact-ad.jp', 'yimg.jp/images/listing', 'yjtag.yahoo.co.jp',
  's.yjtag.jp', 'b92.yahoo.co.jp', 'logql.yahoo.co.jp',
].filter((d) => !d.includes('/'));

const SET = new Set(TRACKERS);

export function isTrackerHost(host) {
  let h = host.toLowerCase();
  while (h) {
    if (SET.has(h)) return true;
    const dot = h.indexOf('.');
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
  return false;
}
