import { passwordSchema } from '@/features/auth/schemas/common';

// FREQ-323: パスワード長の境界を固定する。
//
// 最小長は 16。OWASP ASVS 4.0.3 の 2.1.1 が求める 12 を上回る設定。
// 文字種の構成規則は**意図的に持たない**（NIST SP 800-63B と ASVS 2.1.9 が非推奨。
// 強度は長さと漏洩リスト照合で担保する）。

describe('passwordSchema', () => {
  test('15 文字は拒否する', () => {
    const result = passwordSchema.safeParse('a'.repeat(15));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('16文字以上');
    }
  });

  test('16 文字は通す', () => {
    expect(passwordSchema.safeParse('a'.repeat(16)).success).toBe(true);
  });

  test('128 文字は通す', () => {
    expect(passwordSchema.safeParse('a'.repeat(128)).success).toBe(true);
  });

  test('129 文字は拒否する', () => {
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  // 構成規則を足していないことの回帰ガード。
  // 記号や数字が無くても、長さを満たしていれば通ること。
  test('記号や数字が無くても長さを満たせば通す（構成規則を持たない）', () => {
    expect(passwordSchema.safeParse('correcthorsebatterystaple').success).toBe(true);
  });
});
