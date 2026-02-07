import { ResetRequestSchema, ResetConfirmSchema } from '@/features/auth/schemas/password-reset';

describe('ResetRequestSchema', () => {
  test('valid email passes', () => {
    const parsed = ResetRequestSchema.safeParse({ email: 'user@example.com' });
    expect(parsed.success).toBe(true);
  });

  test('invalid email fails with Japanese message', () => {
    const parsed = ResetRequestSchema.safeParse({ email: 'bad' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/メールアドレス/);
    }
  });
});

describe('ResetConfirmSchema', () => {
  test('valid data passes', () => {
    const parsed = ResetConfirmSchema.safeParse({ token: 'tok', email: 'user@example.com', new_password: 'password123' });
    expect(parsed.success).toBe(true);
  });

  test('missing token fails', () => {
    const parsed = ResetConfirmSchema.safeParse({ email: 'user@example.com', new_password: 'password123' });
    expect(parsed.success).toBe(false);
  });
});
