import { z } from 'zod';
import { emailSchema, passwordSchema } from './common';

export const RegisterRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  display_name: z.string().max(100).optional(),
  emailRedirectTo: z.string().max(2000).optional(),
  redirect_to: z.string().max(2000).optional(),
  turnstileToken: z.string().min(1).optional(),
});

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  id: z.string().optional(),
  email: z.string().email().optional(),
});

export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;
