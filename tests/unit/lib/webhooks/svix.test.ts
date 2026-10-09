import { createHmac } from 'node:crypto';
import { isSvixTimestampFresh, verifySvixSignature } from '@/lib/webhooks/svix';

const KEY = Buffer.from('svix-test-secret-0123456789').toString('base64');
const SECRET = `whsec_${KEY}`;

function sign(secret: string, id: string, timestamp: string, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64')}`;
}

describe('verifySvixSignature', () => {
  const id = 'msg_1';
  const timestamp = '1760000000';
  const payload = '{"type":"email.delivered"}';

  it('届いたままの本文で作った署名を通す', () => {
    expect(verifySvixSignature(SECRET, id, timestamp, sign(SECRET, id, timestamp, payload), payload)).toBe(true);
  });

  it('本文が1文字でも違えば断る', () => {
    expect(verifySvixSignature(SECRET, id, timestamp, sign(SECRET, id, timestamp, payload), `${payload} `)).toBe(false);
  });

  it('鍵の作り直しの間は署名が並ぶ。どれか1つが合えば通す', () => {
    const old = sign(`whsec_${Buffer.from('old-secret').toString('base64')}`, id, timestamp, payload);
    expect(verifySvixSignature(SECRET, id, timestamp, `${old} ${sign(SECRET, id, timestamp, payload)}`, payload)).toBe(true);
    expect(verifySvixSignature(SECRET, id, timestamp, old, payload)).toBe(false);
  });
});

describe('isSvixTimestampFresh', () => {
  const now = 1_760_000_000_000;

  it('前後5分までを通す', () => {
    expect(isSvixTimestampFresh(String(now / 1000 - 300), now)).toBe(true);
    expect(isSvixTimestampFresh(String(now / 1000 + 300), now)).toBe(true);
    expect(isSvixTimestampFresh(String(now / 1000 - 301), now)).toBe(false);
    expect(isSvixTimestampFresh(String(now / 1000 + 301), now)).toBe(false);
    expect(isSvixTimestampFresh('soon', now)).toBe(false);
  });
});
