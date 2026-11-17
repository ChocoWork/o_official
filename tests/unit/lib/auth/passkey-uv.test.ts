/** @jest-environment node */
/**
 * DD-AUTH-051 UV の印の読み取り（src/lib/auth/passkey-uv.ts）の単体テスト。1a のソフトの認証器で作った応答を読む。
 */
import { createSoftAuthenticator, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '../../../../e2e/passkey-soft-authenticator';
import { isBase64Url, readAttestationUserVerified, readAuthenticatorDataFlags } from '@/lib/auth/passkey-uv';

const CONFIG = { origin: 'http://localhost:3000', rpId: 'localhost' };

const creation = (): PublicKeyCredentialCreationOptionsJSON =>
  ({
    challenge: 'Y2hhbGxlbmdl',
    rp: { id: 'localhost', name: 'x' },
    user: { id: 'dXNlci1oYW5kbGU', name: 'a', displayName: 'a' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  }) as PublicKeyCredentialCreationOptionsJSON;
const request = (): PublicKeyCredentialRequestOptionsJSON =>
  ({ challenge: 'cmVxdWVzdA', rpId: 'localhost' }) as PublicKeyCredentialRequestOptionsJSON;

const b64u = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString('base64url');

// 小さな CBOR の書き手（試験用）
const head = (major: number, n: number) => Buffer.from(n < 24 ? [(major << 5) | n] : [(major << 5) | 24, n]);
const text = (s: string) => Buffer.concat([head(3, s.length), Buffer.from(s)]);
const bytes = (b: Buffer) => Buffer.concat([head(2, b.length), b]);
const map = (entries: Array<[Buffer, Buffer]>) => Buffer.concat([head(5, entries.length), ...entries.flat()]);
const nested = (depth: number): Buffer => (depth === 0 ? head(0, 1) : Buffer.concat([head(4, 1), nested(depth - 1)]));

function authData(flags: number, length = 37): Buffer {
  const data = Buffer.alloc(length);
  if (length > 32) data[32] = flags;
  return data;
}
const attestation = (data: Buffer, extra: Array<[Buffer, Buffer]> = []) =>
  map([[text('fmt'), text('none')], [text('attStmt'), map([])], [text('authData'), bytes(data)], ...extra]);

describe('DD-AUTH-051 readAuthenticatorDataFlags', () => {
  test('DD-AUTH-051 UV ありの応答は userPresent・userVerified とも真', () => {
    const res = createSoftAuthenticator(CONFIG).authenticate(request());
    expect(readAuthenticatorDataFlags(res.response.authenticatorData)).toEqual({ userPresent: true, userVerified: true });
  });

  test('DD-AUTH-051 UV なしの応答は userVerified が偽', () => {
    const res = createSoftAuthenticator(CONFIG).authenticate(request(), { userVerified: false });
    expect(readAuthenticatorDataFlags(res.response.authenticatorData)).toEqual({ userPresent: true, userVerified: false });
  });

  test('DD-AUTH-051 37バイトは読め、36バイトは null', () => {
    expect(readAuthenticatorDataFlags(b64u(authData(0x05, 37)))).toEqual({ userPresent: true, userVerified: true });
    expect(readAuthenticatorDataFlags(b64u(authData(0x05, 36)))).toBeNull();
  });

  test('DD-AUTH-051 空・文字列でない・壊れた base64url は null', () => {
    expect(readAuthenticatorDataFlags('')).toBeNull();
    expect(readAuthenticatorDataFlags(null)).toBeNull();
    expect(readAuthenticatorDataFlags(123)).toBeNull();
    expect(readAuthenticatorDataFlags(undefined)).toBeNull();
    expect(readAuthenticatorDataFlags(`${b64u(authData(0x05))}!`)).toBeNull();
    expect(readAuthenticatorDataFlags(`${b64u(authData(0x05))}=`)).toBeNull();
    expect(readAuthenticatorDataFlags('A')).toBeNull();
  });
});

describe('DD-AUTH-051 isBase64Url', () => {
  test('DD-AUTH-051 形が合うものだけ真', () => {
    expect(isBase64Url('abc-_9')).toBe(true);
    expect(isBase64Url('')).toBe(false);
    expect(isBase64Url('ab+/')).toBe(false);
    expect(isBase64Url('abcde')).toBe(false);
    expect(isBase64Url(1)).toBe(false);
  });
});

describe('DD-AUTH-051 readAttestationUserVerified', () => {
  test('DD-AUTH-051 ソフトの認証器の登録で UV ありは真、なしは偽', () => {
    const on = createSoftAuthenticator(CONFIG).register(creation());
    const off = createSoftAuthenticator(CONFIG).register(creation(), { userVerified: false });
    expect(readAttestationUserVerified(on.response.attestationObject)).toBe(true);
    expect(readAttestationUserVerified(off.response.attestationObject)).toBe(false);
  });

  test('DD-AUTH-051 途中で切れた CBOR は null', () => {
    const full = attestation(authData(0x45));
    for (const cut of [0, 1, 5, full.length - 1]) {
      expect(readAttestationUserVerified(b64u(full.subarray(0, cut)))).toBeNull();
    }
  });

  test('DD-AUTH-051 余りのバイトがあれば null', () => {
    expect(readAttestationUserVerified(b64u(Buffer.concat([attestation(authData(0x45)), Buffer.from([0])])))).toBeNull();
  });

  test('DD-AUTH-051 authData が無い・バイト列でない・短すぎるなら null', () => {
    expect(readAttestationUserVerified(b64u(map([[text('fmt'), text('none')]])))).toBeNull();
    expect(readAttestationUserVerified(b64u(map([[text('authData'), text('x')]])))).toBeNull();
    expect(readAttestationUserVerified(b64u(attestation(authData(0x45, 36))))).toBeNull();
  });

  test('DD-AUTH-051 map でない最上位・文字列でない入力は null', () => {
    expect(readAttestationUserVerified(b64u(head(4, 0)))).toBeNull();
    expect(readAttestationUserVerified(null)).toBeNull();
    expect(readAttestationUserVerified('')).toBeNull();
    expect(readAttestationUserVerified('!!')).toBeNull();
  });

  test('DD-AUTH-051 入れ子は深さ8まで読め、9以上は null', () => {
    // 最上位の map が1段目。余分な値の入れ子が 7 段で合計8段、8 段で合計9段
    expect(readAttestationUserVerified(b64u(attestation(authData(0x45), [[text('x'), nested(7)]])))).toBe(true);
    expect(readAttestationUserVerified(b64u(attestation(authData(0x45), [[text('x'), nested(8)]])))).toBeNull();
  });

  test('DD-AUTH-051 偽りの長さ（残りより多い項目数）は null', () => {
    const lie = Buffer.concat([Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff])]);
    expect(readAttestationUserVerified(b64u(lie))).toBeNull();
    const lie2 = Buffer.from([0xa1, 0x5a, 0xff, 0xff, 0xff, 0xff]);
    expect(readAttestationUserVerified(b64u(lie2))).toBeNull();
  });

  test('DD-AUTH-051 項目の数は足りても、入れ子の中で値が足りなければ null', () => {
    expect(readAttestationUserVerified(b64u(Buffer.from([0x82, 0x81, 0x01])))).toBeNull();
  });

  test('DD-AUTH-051 整数・真偽・null・配列は読み飛ばせ、未対応の型（浮動小数・不定長）は null', () => {
    const extra: Array<[Buffer, Buffer]> = [
      [text('a'), head(0, 5)],
      [text('b'), head(1, 3)],
      [text('c'), Buffer.from([0xf5])],
      [text('d'), Buffer.from([0xf4])],
      [text('e'), Buffer.from([0xf6])],
      [text('f'), Buffer.concat([head(4, 2), head(0, 1), text('z')])],
    ];
    expect(readAttestationUserVerified(b64u(attestation(authData(0x41), extra)))).toBe(false);
    expect(readAttestationUserVerified(b64u(attestation(authData(0x45), [[text('g'), Buffer.from([0xf9, 0, 0])]])))).toBeNull();
    expect(readAttestationUserVerified(b64u(attestation(authData(0x45), [[text('g'), Buffer.from([0x9f, 0xff])]])))).toBeNull();
  });
});
