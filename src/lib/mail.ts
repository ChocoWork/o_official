type MailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  replyTo?: string;
};

export async function sendMail(payload: MailPayload) {
  const provider = process.env.MAIL_PROVIDER || 'ses';

  switch (provider) {
    case 'ses': {
      const adapter = await import('./mail/adapters/ses');
      return adapter.sendMail(payload);
    }
    case 'resend': {
      const adapter = await import('./mail/adapters/resend');
      return adapter.sendMail(payload);
    }
    default:
      throw new Error(`Unsupported mail provider: ${provider}`);
  }
}

export default sendMail;
