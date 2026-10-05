type MailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

const DEFAULT_LOCAL_MAIL_URL = 'http://127.0.0.1:54324';
const DEFAULT_LOCAL_SENDER = 'no-reply@localhost.test';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * 手元のメール受け（Supabase CLI に付いている Mailpit）の住所。
 * 手元以外の住所は断る。E2E と普段の開発のメールを外へ出さないため（設計書 2026-10-05 グループ B の 7-5）。
 */
export function resolveLocalMailUrl(raw: string | undefined): URL {
  const url = new URL(raw || DEFAULT_LOCAL_MAIL_URL);
  if (!LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new Error(`MAIL_LOCAL_URL must point to localhost (got ${url.hostname})`);
  }
  return url;
}

export async function sendMail({ to, subject, html, text, from, replyTo }: MailPayload) {
  if (!html && !text) throw new Error('Either html or text must be provided');
  const base = resolveLocalMailUrl(process.env.MAIL_LOCAL_URL);
  const sender = from || process.env.MAIL_FROM_ADDRESS || DEFAULT_LOCAL_SENDER;

  // Mailpit の送信 API（POST /api/v1/send）。SMTP を開けずに、既存の画面の口で受け取れる。
  const response = await fetch(new URL('/api/v1/send', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      From: { Email: sender },
      To: [{ Email: to }],
      Subject: subject,
      ...(text ? { Text: text } : {}),
      ...(html ? { HTML: html } : {}),
      ...(replyTo ? { ReplyTo: [{ Email: replyTo }] } : {}),
    }),
  });

  if (!response.ok) throw new Error(`Local mail send failed: HTTP ${response.status}`);
  return (await response.json()) as { ID: string };
}

export default sendMail;
