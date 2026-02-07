import { z } from 'zod';

export const RefreshResponseSchema = z.object({
  access_token: z.string().optional(),
  user: z.object({ id: z.string(), email: z.string().email() }).optional(),
});

export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
