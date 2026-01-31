import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

type MailPayload = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
};

const REGION = process.env.AWS_REGION || 'us-east-1';

export async function sendMail({ to, subject, html, text, from }: MailPayload) {
  const sender = from || process.env.MAIL_FROM_ADDRESS;
  if (!sender) throw new Error('MAIL_FROM_ADDRESS must be set');

  const client = new SESClient({ region: REGION });

  const params = {
    Destination: { ToAddresses: [to] },
    Message: {
      Body: {
        Html: html ? { Charset: 'UTF-8', Data: html } : undefined,
        Text: text ? { Charset: 'UTF-8', Data: text } : undefined,
      },
      Subject: { Charset: 'UTF-8', Data: subject },
    },
    Source: sender,
  } as any;

  const cmd = new SendEmailCommand(params);
  const res = await client.send(cmd);
  return res;
}

export default sendMail;
