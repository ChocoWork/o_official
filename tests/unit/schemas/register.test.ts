import { RegisterRequestSchema } from '@/features/auth/schemas/register';

describe('RegisterRequestSchema', () => {
  test('valid data passes', () => {
    const data = { email: 'new@example.com', password: 'securepassword', display_name: '太郎' };
    const parsed = RegisterRequestSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  test('missing password fails', () => {
    const data = { email: 'new@example.com', display_name: '太郎' };
    const parsed = RegisterRequestSchema.safeParse(data);
    expect(parsed.success).toBe(false);
  });

  test('short password returns Japanese message', () => {
    const data = { email: 'new@example.com', password: 'short' };
    const parsed = RegisterRequestSchema.safeParse(data);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/パスワードは8文字以上/);
    }
  });
});
