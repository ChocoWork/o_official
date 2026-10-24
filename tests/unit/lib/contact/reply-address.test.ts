import { createHmac } from 'node:crypto';
import { buildReplyAddress, parseReplyAddress } from '@/lib/contact/reply-address';

const ID = '123e4567-e89b-12d3-a456-426614174000';
const DOMAIN = 'mail.example.com';
const SECRET = 'test-secret';

function tokenFor(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url').slice(0, 16);
}

type EnvName = 'CONTACT_INBOUND_DOMAIN' | 'CONTACT_REPLY_SECRET';

function setEnv(name: EnvName, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('reply-address', () => {
  const original = {
    domain: process.env.CONTACT_INBOUND_DOMAIN,
    secret: process.env.CONTACT_REPLY_SECRET,
  };

  beforeEach(() => {
    process.env.CONTACT_INBOUND_DOMAIN = DOMAIN;
    process.env.CONTACT_REPLY_SECRET = SECRET;
  });

  afterAll(() => {
    setEnv('CONTACT_INBOUND_DOMAIN', original.domain);
    setEnv('CONTACT_REPLY_SECRET', original.secret);
  });

  describe('buildReplyAddress', () => {
    it('DD-ADMIN-013 ドメインと鍵がある時は reply+<id>.<16 字の印>@<ドメイン> を返す', () => {
      const address = buildReplyAddress(ID);

      expect(address).toBe(`reply+${ID}.${tokenFor(ID, SECRET)}@${DOMAIN}`);
      const token = address!.split('.')[1].split('@')[0];
      expect(token).toHaveLength(16);
      expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    });

    it('DD-ADMIN-013 同じ id と鍵では同じ印、違う id や違う鍵では違う印になる', () => {
      const otherId = '223e4567-e89b-12d3-a456-426614174000';
      const first = buildReplyAddress(ID);

      expect(buildReplyAddress(ID)).toBe(first);
      expect(buildReplyAddress(otherId)).not.toBe(first);

      process.env.CONTACT_REPLY_SECRET = 'another-secret';
      expect(buildReplyAddress(ID)).not.toBe(first);
    });

    it('DD-ADMIN-013 id を小文字にそろえずそのまま入れる', () => {
      const upper = ID.toUpperCase();

      expect(buildReplyAddress(upper)).toBe(`reply+${upper}.${tokenFor(upper, SECRET)}@${DOMAIN}`);
    });

    it.each([
      ['ドメインが無い', 'CONTACT_INBOUND_DOMAIN', undefined],
      ['ドメインが空の字', 'CONTACT_INBOUND_DOMAIN', ''],
      ['鍵が無い', 'CONTACT_REPLY_SECRET', undefined],
      ['鍵が空の字', 'CONTACT_REPLY_SECRET', ''],
    ] as const)('DD-ADMIN-013 %s時は null を返す', (_label, name, value) => {
      setEnv(name, value);

      expect(buildReplyAddress(ID)).toBeNull();
    });
  });

  describe('parseReplyAddress', () => {
    it('DD-ADMIN-014 鍵が無い時は null を返す', () => {
      const address = buildReplyAddress(ID)!;
      delete process.env.CONTACT_REPLY_SECRET;

      expect(parseReplyAddress(address)).toBeNull();
    });

    it('DD-ADMIN-014 鍵が空の字の時も null を返す', () => {
      const address = buildReplyAddress(ID)!;
      process.env.CONTACT_REPLY_SECRET = '';

      expect(parseReplyAddress(address)).toBeNull();
    });

    it.each([
      ['reply+ の形が無い宛先', 'support@mail.example.com'],
      ['id が 35 字の宛先', `reply+${ID.slice(0, 35)}.${tokenFor(ID, SECRET)}@${DOMAIN}`],
      ['印が無い宛先', `reply+${ID}.@${DOMAIN}`],
      ['印の前の . が無い宛先', `reply+${ID}@${DOMAIN}`],
      ['@ の無い宛先', `reply+${ID}.${tokenFor(ID, SECRET)}`],
    ])('DD-ADMIN-014 %s は null を返す', (_label, address) => {
      expect(parseReplyAddress(address)).toBeNull();
    });

    it('DD-ADMIN-014 作った宛先を素のまま渡すと小文字の id と valid 真を返す', () => {
      expect(parseReplyAddress(buildReplyAddress(ID)!)).toEqual({ inquiryId: ID, valid: true });
    });

    it('DD-ADMIN-014 名前付きの宛先でも同じ結果を返す', () => {
      const address = buildReplyAddress(ID)!;

      expect(parseReplyAddress(`Shop <${address}>`)).toEqual({ inquiryId: ID, valid: true });
    });

    it('DD-ADMIN-014 印を1字変えた宛先は valid 偽を返す', () => {
      const token = tokenFor(ID, SECRET);
      const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);

      expect(parseReplyAddress(`reply+${ID}.${flipped}@${DOMAIN}`)).toEqual({
        inquiryId: ID,
        valid: false,
      });
    });

    it('DD-ADMIN-014 印を短くした宛先は長さが違うので valid 偽を返す', () => {
      const token = tokenFor(ID, SECRET).slice(0, 15);

      expect(parseReplyAddress(`reply+${ID}.${token}@${DOMAIN}`)).toEqual({
        inquiryId: ID,
        valid: false,
      });
    });

    it('DD-ADMIN-014 別の鍵で作った印は valid 偽を返す', () => {
      process.env.CONTACT_REPLY_SECRET = 'another-secret';
      const address = buildReplyAddress(ID)!;
      process.env.CONTACT_REPLY_SECRET = SECRET;

      expect(parseReplyAddress(address)).toEqual({ inquiryId: ID, valid: false });
    });

    it('DD-ADMIN-014 大文字の id の宛先は id を小文字で返し、小文字で作り直すので印が合わず valid 偽を返す', () => {
      const address = buildReplyAddress(ID.toUpperCase())!;

      expect(parseReplyAddress(address)).toEqual({ inquiryId: ID, valid: false });
    });
  });
});
