import { z } from 'zod';

export const IdentifyRequestSchema = z.object({
  email: z.string().email('有効なメールアドレスを入力してください'),
  redirect_to: z.string().optional(),
  turnstileToken: z.string().optional(),
});

export type IdentifyRequest = z.infer<typeof IdentifyRequestSchema>;
