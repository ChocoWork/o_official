/**
 * DD-AUTH-075 店員の招待の合言葉（src/features/auth/staff/invite-token.ts）の単体テスト。
 */

import { createHash } from 'node:crypto';

import { buildInviteUrl, createInviteToken, hashInviteToken } from '@/features/auth/staff/invite-token';

const FIXED_TOKEN = '0123456789abcdef0123456789abcdef0123456789a';
const FIXED_HASH_HEX = '263b9741bfc84598b8f5688c5481887c8493d40b0b557de2f2f9b0329139c5db';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('invite-token', () => {
  it('DD-AUTH-075 createInviteToken は毎回違う43字の base64url を返す', () => {
    const a = createInviteToken();
    const b = createInviteToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });

  it('DD-AUTH-075 createInviteToken のハッシュは合言葉の文字列の UTF-8 の SHA-256（生の32バイトではない）', () => {
    const { token, tokenHash } = createInviteToken();
    expect(tokenHash).toBeInstanceOf(Uint8Array);
    expect(tokenHash).toHaveLength(32);
    expect(hex(tokenHash)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hex(tokenHash)).not.toBe(createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'));
    expect(hex(hashInviteToken(token))).toBe(hex(tokenHash));
  });

  it('DD-AUTH-075 hashInviteToken は固定の合言葉に対し、DB の試験と同じ値を返す', () => {
    expect(FIXED_TOKEN).toHaveLength(43);
    expect(hex(hashInviteToken(FIXED_TOKEN))).toBe(FIXED_HASH_HEX);
  });

  it('DD-AUTH-075 buildInviteUrl は合言葉を # の断片に置き、? の検索語にしない', () => {
    const url = buildInviteUrl('https://shop.example.com', FIXED_TOKEN);
    expect(url).toBe(`https://shop.example.com/staff/invite#${FIXED_TOKEN}`);
    expect(url).not.toContain('?');
    expect(url).not.toContain('token=');
    expect(new URL(url).search).toBe('');
    expect(new URL(url).hash).toBe(`#${FIXED_TOKEN}`);
  });

  it('DD-AUTH-075 buildInviteUrl は origin の末尾の / を重ねない', () => {
    expect(buildInviteUrl('https://shop.example.com/', FIXED_TOKEN)).toBe(`https://shop.example.com/staff/invite#${FIXED_TOKEN}`);
  });
});
