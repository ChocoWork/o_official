type MailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

export type MailProvider = 'ses' | 'resend' | 'local';

/**
 * どの送り方を使うかを決める。
 * 普段の開発（next dev）は、設定にかかわらず手元のメール受け（Mailpit）に送る。
 * E2E は起動の仕組みが MAIL_PROVIDER=local を渡す。本番は MAIL_PROVIDER に従う（設計書 2026-10-05 グループ B の 7-5）。
 */
export function resolveMailProvider(
  env: { NODE_ENV?: string; MAIL_PROVIDER?: string } = process.env,
): MailProvider {
  if (env.NODE_ENV === 'development') return 'local';
  const provider = env.MAIL_PROVIDER || 'ses';
  if (provider === 'ses' || provider === 'resend' || provider === 'local') return provider;
  throw new Error(`Unsupported mail provider: ${provider}`);
}

export async function sendMail(payload: MailPayload) {
  switch (resolveMailProvider()) {
    case 'ses': {
      const adapter = await import('./mail/adapters/ses');
      return adapter.sendMail(payload);
    }
    case 'resend': {
      const adapter = await import('./mail/adapters/resend');
      return adapter.sendMail(payload);
    }
    case 'local': {
      const adapter = await import('./mail/adapters/local');
      return adapter.sendMail(payload);
    }
  }
}

export default sendMail;
