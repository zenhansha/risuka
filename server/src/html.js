// Small server-rendered pages (the review page opened from the email) and the email body.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const STATUS = { pending: '審査待ち', approved: '承認済み', rejected: '却下' };

function fmt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function shell(title, body) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f3f4f8;--card:#fff;--fg:#1b2033;--muted:#5d6478;--line:#dde0ea;--ok:#1f7a4d;--ng:#b3372f;--accent:#e0862b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#10131d;--card:#181c2a;--fg:#e8eaf2;--muted:#9aa1b6;--line:#2a3045;--ok:#4fc489;--ng:#f0796f;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif;padding:32px max(16px,env(safe-area-inset-left))}
main{max-width:520px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 16px}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 20px}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.row{display:flex;gap:12px;flex-wrap:wrap}button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 20px;cursor:pointer;color:#fff}
.ok{background:var(--ok)}.ng{background:var(--ng)}button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.pill{display:inline-block;padding:0 10px;border-radius:99px;border:1px solid var(--line)}p{margin:0 0 12px}.muted{color:var(--muted)}
</style></head><body><main>${body}</main></body></html>`;
}

export function reviewPage(app, sig) {
  const hidden = `<input type="hidden" name="app" value="${esc(app.appId)}"><input type="hidden" name="sig" value="${esc(sig)}">`;
  return shell('Orbit の申請', `
<h1>Orbit の申請</h1>
<dl>
  <dt>ID</dt><dd>${esc(app.id)}</dd>
  <dt>申請日時</dt><dd>${fmt(app.createdAt)}</dd>
  <dt>状態</dt><dd><span class="pill">${STATUS[app.status] ?? esc(app.status)}</span></dd>
  <dt>最後の利用</dt><dd>${fmt(app.lastLoginAt)}</dd>
</dl>
<div class="row">
  <form method="post" action="decide">${hidden}<input type="hidden" name="decision" value="approved"><button class="ok" type="submit">承認する</button></form>
  <form method="post" action="decide">${hidden}<input type="hidden" name="decision" value="rejected"><button class="ng" type="submit">${app.status === 'approved' ? '利用を止める' : '却下する'}</button></form>
</div>
<p class="muted" style="margin-top:16px">このページは何度でも開けます。承認したあとで止めたくなったら、ここから「利用を止める」を押してください。</p>`);
}

export function messagePage(title, text) {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
}

export function approvalEmail(app, reviewUrl) {
  const subject = `Orbit の申請: ${app.id}`;
  const text = `Orbit の申請が届きました。

ID: ${app.id}
申請日時: ${fmt(app.createdAt)}

承認または却下はこちら:
${reviewUrl}

心当たりがなければ何もしなくて大丈夫です。`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#1b2033;max-width:480px">
<p>Orbit の申請が届きました。</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="color:#5d6478;padding:2px 16px 2px 0">ID</td><td style="font-family:monospace;font-size:17px;font-weight:700">${esc(app.id)}</td></tr>
<tr><td style="color:#5d6478;padding:2px 16px 2px 0">申請日時</td><td>${fmt(app.createdAt)}</td></tr>
</table>
<p><a href="${esc(reviewUrl)}" style="display:inline-block;background:#1f7a4d;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px">申請を確認して承認する</a></p>
<p style="color:#5d6478;font-size:13px">ボタンを押すと確認ページが開きます。そこで「承認する」を押すと、この ID で Orbit に入れるようになります。心当たりがなければ何もしなくて大丈夫です。</p>
</div>`;
  return { subject, text, html };
}
