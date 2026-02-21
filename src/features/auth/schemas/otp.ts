import { z } from 'zod';

export const OtpVerifyRequestSchema = z.object({
  email: z.string().email('有効なメールアドレスを入力してください'),
  code: z.string().trim().length(8, '認証コードは8桁で入力してください'),
});

export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>;
