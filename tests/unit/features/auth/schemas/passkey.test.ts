/** @jest-environment node */
/**
 * DD-AUTH-051 パスキーの窓口の入力の形（src/features/auth/schemas/passkey.ts）の単体テスト。
 */
import {
  PasskeyCredentialSchema,
  PasskeyLoginFinishSchema,
  PasskeyRegisterFinishSchema,
  PasskeyRenameSchema,
} from '@/features/auth/schemas/passkey';

const UUID = '0b0f2f4e-2f8a-4a4e-9a52-6f1b6b0a1c11';

const loginCredential = (overrides: Record<string, unknown> = {}) => ({
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: { clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA', signature: 'c2ln', userHandle: 'dXNlcg' },
  ...overrides,
});
const registerCredential = (overrides: Record<string, unknown> = {}) => ({
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0', transports: ['internal'] },
  ...overrides,
});

describe('DD-AUTH-051 PasskeyCredentialSchema', () => {
  test('DD-AUTH-051 登録・ログインのどちらの応答の形も通る', () => {
    expect(PasskeyCredentialSchema.safeParse(loginCredential()).success).toBe(true);
    expect(PasskeyCredentialSchema.safeParse(registerCredential()).success).toBe(true);
  });

  test('DD-AUTH-051 id と rawId が違えば断る（SEC-AUTH-044）', () => {
    const parsed = PasskeyCredentialSchema.safeParse(loginCredential({ rawId: 'b3RoZXI' }));
    expect(parsed.success).toBe(false);
  });

  test('DD-AUTH-051 id・rawId が base64url の形でなければ断る', () => {
    expect(PasskeyCredentialSchema.safeParse(loginCredential({ id: 'a+b/', rawId: 'a+b/' })).success).toBe(false);
    expect(PasskeyCredentialSchema.safeParse(loginCredential({ id: '', rawId: '' })).success).toBe(false);
  });

  test('DD-AUTH-051 type が public-key でなければ断る', () => {
    expect(PasskeyCredentialSchema.safeParse(loginCredential({ type: 'password' })).success).toBe(false);
  });

  test('DD-AUTH-051 長すぎる文字列は断る', () => {
    const long = 'a'.repeat(1025);
    expect(PasskeyCredentialSchema.safeParse(loginCredential({ id: long, rawId: long })).success).toBe(false);
  });
});

describe('DD-AUTH-051 PasskeyLoginFinishSchema', () => {
  test('DD-AUTH-051 正しい形は通り、next は任意', () => {
    expect(PasskeyLoginFinishSchema.safeParse({ challenge_id: UUID, credential: loginCredential() }).success).toBe(true);
    expect(
      PasskeyLoginFinishSchema.safeParse({ challenge_id: UUID, credential: loginCredential(), next: '/account' }).success,
    ).toBe(true);
  });

  test('DD-AUTH-051 id と rawId が違えば断る', () => {
    expect(
      PasskeyLoginFinishSchema.safeParse({ challenge_id: UUID, credential: loginCredential({ rawId: 'b3RoZXI' }) }).success,
    ).toBe(false);
  });

  test('DD-AUTH-051 challenge_id が uuid でない・署名が無い・登録の形の応答は断る', () => {
    expect(PasskeyLoginFinishSchema.safeParse({ challenge_id: 'x', credential: loginCredential() }).success).toBe(false);
    expect(
      PasskeyLoginFinishSchema.safeParse({
        challenge_id: UUID,
        credential: loginCredential({ response: { clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA' } }),
      }).success,
    ).toBe(false);
    expect(PasskeyLoginFinishSchema.safeParse({ challenge_id: UUID, credential: registerCredential() }).success).toBe(false);
  });

  test('DD-AUTH-051 next が文字列でない・長すぎるなら断る', () => {
    expect(PasskeyLoginFinishSchema.safeParse({ challenge_id: UUID, credential: loginCredential(), next: 1 }).success).toBe(false);
    expect(
      PasskeyLoginFinishSchema.safeParse({ challenge_id: UUID, credential: loginCredential(), next: 'a'.repeat(2049) }).success,
    ).toBe(false);
  });
});

describe('DD-AUTH-051 PasskeyRegisterFinishSchema', () => {
  test('DD-AUTH-051 登録の形は通り、id と rawId が違えば断る', () => {
    expect(PasskeyRegisterFinishSchema.safeParse({ challenge_id: UUID, credential: registerCredential() }).success).toBe(true);
    expect(
      PasskeyRegisterFinishSchema.safeParse({ challenge_id: UUID, credential: registerCredential({ rawId: 'b3RoZXI' }) }).success,
    ).toBe(false);
  });

  test('DD-AUTH-051 attestationObject が無ければ断る', () => {
    expect(
      PasskeyRegisterFinishSchema.safeParse({
        challenge_id: UUID,
        credential: registerCredential({ response: { clientDataJSON: 'Y2xpZW50' } }),
      }).success,
    ).toBe(false);
  });
});

describe('DD-AUTH-051 PasskeyRenameSchema', () => {
  test('DD-AUTH-051 前後の空白を除いた1〜64字を通す', () => {
    expect(PasskeyRenameSchema.parse({ friendly_name: '  My Mac  ' })).toEqual({ friendly_name: 'My Mac' });
    expect(PasskeyRenameSchema.safeParse({ friendly_name: 'a'.repeat(64) }).success).toBe(true);
  });

  test('DD-AUTH-051 空・空白だけ・65字・制御文字は断る', () => {
    expect(PasskeyRenameSchema.safeParse({ friendly_name: '' }).success).toBe(false);
    expect(PasskeyRenameSchema.safeParse({ friendly_name: '   ' }).success).toBe(false);
    expect(PasskeyRenameSchema.safeParse({ friendly_name: 'a'.repeat(65) }).success).toBe(false);
    expect(PasskeyRenameSchema.safeParse({ friendly_name: 'a\u0000b' }).success).toBe(false);
    expect(PasskeyRenameSchema.safeParse({ friendly_name: 'a\nb' }).success).toBe(false);
    expect(PasskeyRenameSchema.safeParse({ friendly_name: 1 }).success).toBe(false);
  });

  test('DD-AUTH-057 C1 の制御文字・表示の向きを変える文字は断り、長さはコードポイントで数える', () => {
    const forbidden = [0x85, 0x9f, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069];
    for (const code of forbidden) {
      expect(PasskeyRenameSchema.safeParse({ friendly_name: `a${String.fromCharCode(code)}b` }).success).toBe(false);
    }
    // 絵文字は UTF-16 で2単位。64個は通り、65個は断る。
    expect(PasskeyRenameSchema.safeParse({ friendly_name: String.fromCodePoint(0x1f510).repeat(64) }).success).toBe(true);
    expect(PasskeyRenameSchema.safeParse({ friendly_name: String.fromCodePoint(0x1f510).repeat(65) }).success).toBe(false);
  });
});
