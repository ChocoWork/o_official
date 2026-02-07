import { LoginRequestSchema } from '@/features/auth/schemas/login';

describe('LoginRequestSchema', () => {
  test('valid data passes', () => {
    const data = { email: 'user@example.com', password: 'password123' };
    const parsed = LoginRequestSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  test('invalid email fails with Japanese message', () => {
    const data = { email: 'invalid-email', password: 'password123' };
    const parsed = LoginRequestSchema.safeParse(data);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toMatch(/メールアドレス/);
    }
  });

  test('short password fails with Japanese message', () => {
    const data = { email: 'user@example.com', password: 'short' };
    const parsed = LoginRequestSchema.safeParse(data);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/パスワードは8文字以上/);
    }
  });
});
