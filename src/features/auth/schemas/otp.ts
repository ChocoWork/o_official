import { z } from 'zod';

// 宛先はサーバー側の 2FA Cookie から取る。クライアントに宛先を持たせると、
// 偽装しうる入力が増えるだけで得るものが無い（従来は Cookie と一致必須だった）。
export const OtpVerifyRequestSchema = z.object({
  code: z.string().trim().length(8, '認証コードは8桁で入力してください'),
});

export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>;
