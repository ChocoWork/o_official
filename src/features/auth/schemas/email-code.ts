import { z } from 'zod';
import { emailSchema } from './common';

/**
 * メールのコードのログインの始めの本文（src/features/auth/schemas/email-code.ts）。
 *
 * @design DD-AUTH-059
 * @remarks メールの規則は今の `LoginRequestSchema` と同じ（`emailSchema`）。パスワードは持たない。
 * 確定の本文（`code`）は今の `OtpVerifyRequestSchema` をそのまま使う。
 */
export const EmailCodeStartRequestSchema = z.object({
  email: emailSchema,
  turnstileToken: z.string().min(1).optional(),
  next: z.unknown().optional(),
});

export type EmailCodeStartRequest = z.infer<typeof EmailCodeStartRequestSchema>;
