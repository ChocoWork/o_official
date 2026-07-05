import { z } from 'zod';
import { emailSchema, passwordSchema } from './common';

export const LoginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  turnstileToken: z.string().min(1).optional(),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  access_token: z.string().optional(),
  user: z
    .object({ id: z.string(), email: z.string().email(), display_name: z.string().optional() })
    .optional(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;
