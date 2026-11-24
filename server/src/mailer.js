// Sends the approval email to the owner through Resend's HTTP API (free plan).
// Without an API key (local development) the link is printed to the console instead.
export function createMailer({ apiKey, from, to, log = console.log }) {
  const sent = []; // kept for tests and dev mode

  return {
    sent,
    async send({ subject, text, html }) {
      sent.push({ to, subject, text, html });
      if (!apiKey) {
        log(`[mail] RESEND_API_KEY is not set. Would send to ${to || '(owner)'}:\n${subject}\n${text}`);
        return { dev: true };
      }
      if (!to) throw new Error('ORBIT_OWNER_EMAIL is not set');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend responded ${res.status}: ${body.slice(0, 300)}`);
      }
      return res.json();
    },
  };
}
