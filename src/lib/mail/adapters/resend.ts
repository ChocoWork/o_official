import { Resend, type CreateEmailOptions } from 'resend';

type MailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

export async function sendMail({ to, subject, html, text, from, replyTo }: MailPayload) {
  const sender = from || process.env.MAIL_FROM_ADDRESS;
  if (!sender) throw new Error('MAIL_FROM_ADDRESS must be set');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY must be set');
  if (!html && !text) throw new Error('Either html or text must be provided');

  const resend = new Resend(process.env.RESEND_API_KEY);

  // html / text のうち渡されたものだけ載せる（空 html を送らない）
  const payload = {
    from: sender,
    to,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(replyTo ? { replyTo } : {}),
  } as CreateEmailOptions;

  // Resend SDK は例外を投げず { data, error } を返す。error を明示的に確認する。
  const { data, error } = await resend.emails.send(payload);

  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return data;
}

export default sendMail;
