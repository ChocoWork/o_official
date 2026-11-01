/** @jest-environment node */
/**
 * DD-AUTH-041 パスワード変更の窓口の入力の形（src/features/auth/schemas/password-change.ts）。
 */
import { PasswordChangeConfirmSchema, PasswordChangeStartSchema } from '@/features/auth/schemas/password-change';

describe('DD-AUTH-041 PasswordChangeStartSchema', () => {
  test('DD-AUTH-041 現行パスワードは 1〜128 文字で通る', () => {
    expect(PasswordChangeStartSchema.safeParse({ current_password: 'a' }).success).toBe(true);
    expect(PasswordChangeStartSchema.safeParse({ current_password: 'a'.repeat(128) }).success).toBe(true);
  });

  test('DD-AUTH-041 空・129 文字・文字列でない値は断る', () => {
    expect(PasswordChangeStartSchema.safeParse({ current_password: '' }).success).toBe(false);
    expect(PasswordChangeStartSchema.safeParse({ current_password: 'a'.repeat(129) }).success).toBe(false);
    expect(PasswordChangeStartSchema.safeParse({ current_password: 12345678 }).success).toBe(false);
    expect(PasswordChangeStartSchema.safeParse({}).success).toBe(false);
  });
});

describe('DD-AUTH-041 PasswordChangeConfirmSchema', () => {
  const valid = { code: '01234567', new_password: 'a'.repeat(16) };

  test('DD-AUTH-041 8 桁の数字（先頭 0 を含む）と 16 文字のパスワードで通る', () => {
    expect(PasswordChangeConfirmSchema.safeParse(valid).success).toBe(true);
  });

  test.each(['1234567', '123456789', '1234567a', 'abcdefgh', '', '１２３４５６７８', '1234 567'])(
    'DD-AUTH-041 コード %p は断る',
    (code) => {
      expect(PasswordChangeConfirmSchema.safeParse({ ...valid, code }).success).toBe(false);
    },
  );

  test('DD-AUTH-041 コードが数値型なら断る（先頭 0 が消えるため）', () => {
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, code: 1234567 }).success).toBe(false);
  });

  test('DD-AUTH-041 新パスワード 15 文字は断り、16 文字と 72 バイトは通り、73 バイトと 129 文字は断る', () => {
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, new_password: 'a'.repeat(15) }).success).toBe(false);
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, new_password: 'a'.repeat(16) }).success).toBe(true);
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, new_password: 'a'.repeat(72) }).success).toBe(true);
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, new_password: 'a'.repeat(73) }).success).toBe(false);
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, new_password: 'あ'.repeat(24) }).success).toBe(true);
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, new_password: 'あ'.repeat(25) }).success).toBe(false);
    expect(PasswordChangeConfirmSchema.safeParse({ ...valid, new_password: 'a'.repeat(129) }).success).toBe(false);
  });
});
