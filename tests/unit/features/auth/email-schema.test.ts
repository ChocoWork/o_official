/** @jest-environment node */
/**
 * DD-AUTH-018 会員登録・ログイン・再設定が共有するメールの入力の形（src/features/auth/schemas/common.ts）。
 */
import { emailSchema } from '@/features/auth/schemas/common';
import { LoginRequestSchema } from '@/features/auth/schemas/login';

describe('DD-AUTH-018 emailSchema', () => {
  test('DD-AUTH-018 前後に空白のあるメールは空白を取って小文字にした値で通る', () => {
    const parsed = emailSchema.safeParse('  Owner@Example.com \t');
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe('owner@example.com');
  });

  test('DD-AUTH-018 空白だけ・形の崩れたメール・文字列でない値は断る', () => {
    expect(emailSchema.safeParse('   ').success).toBe(false);
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse(' a b@example.com ').success).toBe(false);
    expect(emailSchema.safeParse(123).success).toBe(false);
  });

  test('DD-AUTH-018 ログインの入力でも前後の空白のあるメールが通る', () => {
    const parsed = LoginRequestSchema.safeParse({ email: ' User@Example.com ', password: 'a'.repeat(16) });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.email).toBe('user@example.com');
  });
});
