import { createHmac } from 'node:crypto';
import { buildReplyAddress, parseReplyAddress } from '@/lib/contact/reply-address';

const INQUIRY_ID = '3f2b8c1e-9a4d-4e7b-8c55-0a1b2c3d4e5f';
const DOMAIN = 'mail.example.test';
const SECRET = 'reply-secret-for-test';

function tokenOf(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url').slice(0, 16);
}

describe('問い合わせの返信の宛先（ARC-ADMIN-004）', () => {
  const original = {
    domain: process.env.CONTACT_INBOUND_DOMAIN,
    secret: process.env.CONTACT_REPLY_SECRET,
  };

  function configure(domain: string | undefined, secret: string | undefined) {
    if (domain === undefined) delete process.env.CONTACT_INBOUND_DOMAIN;
    else process.env.CONTACT_INBOUND_DOMAIN = domain;
    if (secret === undefined) delete process.env.CONTACT_REPLY_SECRET;
    else process.env.CONTACT_REPLY_SECRET = secret;
  }

  beforeEach(() => configure(DOMAIN, SECRET));

  afterAll(() => configure(original.domain, original.secret));

  it('ARC-ADMIN-004 宛先は reply+{id}.{印}@{ドメイン} の形で、印は鍵で作った id の HMAC の先頭16字', () => {
    const address = buildReplyAddress(INQUIRY_ID);

    expect(address).toBe(`reply+${INQUIRY_ID}.${tokenOf(INQUIRY_ID, SECRET)}@${DOMAIN}`);
    expect(tokenOf(INQUIRY_ID, SECRET)).toHaveLength(16);
  });

  it('ARC-ADMIN-004 鍵が違えば同じ id でも印が変わる', () => {
    const first = buildReplyAddress(INQUIRY_ID);
    configure(DOMAIN, 'another-secret');

    expect(buildReplyAddress(INQUIRY_ID)).not.toBe(first);
  });

  it('ARC-ADMIN-004 受信ドメインが無ければ宛先を作らず null を返す', () => {
    configure(undefined, SECRET);

    expect(buildReplyAddress(INQUIRY_ID)).toBeNull();
  });

  it('ARC-ADMIN-004 鍵が無ければ宛先を作らず null を返す', () => {
    configure(DOMAIN, undefined);

    expect(buildReplyAddress(INQUIRY_ID)).toBeNull();
  });

  it('ARC-ADMIN-004 作った宛先を受信側で読むと同じ id が正しい印つきで戻る', () => {
    const address = buildReplyAddress(INQUIRY_ID) as string;

    expect(parseReplyAddress(address)).toEqual({ inquiryId: INQUIRY_ID, valid: true });
  });

  it('ARC-ADMIN-004 名前付きの宛先の形でも読める', () => {
    const address = buildReplyAddress(INQUIRY_ID) as string;

    expect(parseReplyAddress(`Shop Support <${address}>`)).toEqual({ inquiryId: INQUIRY_ID, valid: true });
  });

  it('ARC-ADMIN-004 大文字の id は小文字にそろえて印を確かめる', () => {
    const upper = INQUIRY_ID.toUpperCase();
    const address = `reply+${upper}.${tokenOf(INQUIRY_ID, SECRET)}@${DOMAIN}`;

    expect(parseReplyAddress(address)).toEqual({ inquiryId: INQUIRY_ID, valid: true });
  });

  it('ARC-ADMIN-004 印が書き換えられていれば id を返しつつ合否は false', () => {
    const forged = `reply+${INQUIRY_ID}.${'A'.repeat(16)}@${DOMAIN}`;

    expect(parseReplyAddress(forged)).toEqual({ inquiryId: INQUIRY_ID, valid: false });
  });

  it('ARC-ADMIN-004 印の長さが違えば合否は false（比較の前に長さで落とす）', () => {
    const short = `reply+${INQUIRY_ID}.${tokenOf(INQUIRY_ID, SECRET).slice(0, 8)}@${DOMAIN}`;
    const long = `reply+${INQUIRY_ID}.${tokenOf(INQUIRY_ID, SECRET)}extra@${DOMAIN}`;

    expect(parseReplyAddress(short)).toEqual({ inquiryId: INQUIRY_ID, valid: false });
    expect(parseReplyAddress(long)).toEqual({ inquiryId: INQUIRY_ID, valid: false });
  });

  it('ARC-ADMIN-004 別の id 用の印を使い回しても合否は false', () => {
    const otherId = '00000000-0000-4000-8000-000000000000';
    const swapped = `reply+${otherId}.${tokenOf(INQUIRY_ID, SECRET)}@${DOMAIN}`;

    expect(parseReplyAddress(swapped)).toEqual({ inquiryId: otherId, valid: false });
  });

  it('ARC-ADMIN-004 鍵が違う環境で作った宛先は合否が false', () => {
    const address = buildReplyAddress(INQUIRY_ID) as string;
    configure(DOMAIN, 'rotated-secret');

    expect(parseReplyAddress(address)).toEqual({ inquiryId: INQUIRY_ID, valid: false });
  });

  it('ARC-ADMIN-004 鍵が無ければ読まずに null を返す', () => {
    const address = buildReplyAddress(INQUIRY_ID) as string;
    configure(DOMAIN, undefined);

    expect(parseReplyAddress(address)).toBeNull();
  });

  it('ARC-ADMIN-004 reply+ の形でない宛先や UUID の形でない id は null を返す', () => {
    expect(parseReplyAddress('support@example.test')).toBeNull();
    expect(parseReplyAddress(`reply+not-a-uuid.${'a'.repeat(16)}@${DOMAIN}`)).toBeNull();
    expect(parseReplyAddress('')).toBeNull();
  });
});
