import { z } from 'zod';
import { emailSchema, passwordSchema } from './common';

export const ResetRequestSchema = z.object({
  email: emailSchema,
  turnstileToken: z.string().min(1).optional(),
});

export type ResetRequest = z.infer<typeof ResetRequestSchema>;

export const ResetConfirmSchema = z.object({
  token: z.string().min(1, { message: 'トークンが必要です' }),
  email: emailSchema,
  new_password: passwordSchema,
});

export type ResetConfirm = z.infer<typeof ResetConfirmSchema>;
