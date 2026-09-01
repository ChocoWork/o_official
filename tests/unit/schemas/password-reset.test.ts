import { ResetRequestSchema, ResetSessionConfirmSchema } from '@/features/auth/schemas/password-reset';

describe('password-reset schemas', () => {
  test('ResetRequestSchema はメール形式を検証する', () => {
    expect(ResetRequestSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
    expect(ResetRequestSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  test('ResetRequestSchema はメールを小文字に正規化する', () => {
    const parsed = ResetRequestSchema.safeParse({ email: 'User@Example.COM' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe('user@example.com');
    }
  });

  test('ResetSessionConfirmSchema は new_password のみを受ける', () => {
    expect(ResetSessionConfirmSchema.safeParse({ new_password: 'password123456789' }).success).toBe(true);
  });

  test('ResetSessionConfirmSchema は 8 文字未満を拒否する', () => {
    expect(ResetSessionConfirmSchema.safeParse({ new_password: 'short' }).success).toBe(false);
  });
});

export {};
