/** @jest-environment node */
import crypto from 'crypto';
import {
  ORDER_STATUS_SESSION_COOKIE_NAME,
  ORDER_STATUS_SESSION_MAX_AGE_SECONDS,
  OrderStatusSessionError,
  createOrderStatusSession,
  orderStatusCookieOptions,
  readOrderStatusSession,
} from '@/lib/orders/status/status-session';

jest.mock('server-only', () => ({}), { virtual: true });

// 試験用の作り物の値だけを使う（本物の鍵・トークン・電話は使わない）
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OTHER_ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455557777';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde';
const OTHER_TOKEN = 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-ZyXwV';
const SECRET = 'status-session-test-secret-A';
const OTHER_SECRET = 'status-session-test-secret-B';
const JWT_SECRET_VALUE = 'status-session-test-jwt-secret';

// 固定の時計（待たない・実際の時刻に頼らない）
const NOW = new Date('2026-10-22T03:00:00.000Z');
const IAT = Math.floor(NOW.getTime() / 1000);
const at = (seconds: number) => new Date((IAT + seconds) * 1000);
const iso = (seconds: number) => at(seconds).toISOString();
const FAR = iso(21 * 86400);

const env = process.env as Record<string, string | undefined>;
const ENV_NAMES = ['ORDER_STATUS_SESSION_SECRET', 'JWT_SECRET', 'NODE_ENV'] as const;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: (typeof ENV_NAMES)[number], value: string | undefined) {
  if (value === undefined) {
    delete env[name];
  } else {
    env[name] = value;
  }
}

beforeEach(() => {
  for (const name of ENV_NAMES) savedEnv[name] = env[name];
  setEnv('ORDER_STATUS_SESSION_SECRET', SECRET);
  setEnv('JWT_SECRET', undefined);
});

afterEach(() => {
  for (const name of ENV_NAMES) setEnv(name, savedEnv[name]);
});

// 偽造の道具。実装とは別に、仕様（base64url(JSON).base64url(HMAC-SHA256)）から作る
const base64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const signature = (segment: string, secret = SECRET) => crypto.createHmac('sha256', secret).update(segment).digest('base64url');
const hashPrefix = (token: string) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
function forge(payload: unknown, secret = SECRET): string {
  const segment = base64url(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return `${segment}.${signature(segment, secret)}`;
}
const PAYLOAD = { purpose: 'order_status', orderId: ORDER_ID, tokenHashPrefix: hashPrefix(TOKEN), iat: IAT, exp: IAT + 3600 };

type ReadInput = Parameters<typeof readOrderStatusSession>[1];
const read = (value: string | undefined, overrides: Partial<ReadInput> = {}) =>
  readOrderStatusSession(value, { orderId: ORDER_ID, token: TOKEN, verifyUntil: FAR, now: NOW, ...overrides });
type IssueInput = Parameters<typeof createOrderStatusSession>[0];
const issue = (overrides: Partial<IssueInput> = {}) =>
  createOrderStatusSession({ orderId: ORDER_ID, token: TOKEN, verifyUntil: FAR, now: NOW, ...overrides });

describe('定数', () => {
  test('Cookie名は sb-order-status、最長は24時間', () => {
    expect(ORDER_STATUS_SESSION_COOKIE_NAME).toBe('sb-order-status');
    expect(ORDER_STATUS_SESSION_MAX_AGE_SECONDS).toBe(86400);
  });
});

describe('createOrderStatusSession', () => {
  test('payload は purpose,orderId,tokenHashPrefix,iat,exp の順で、生のトークンを含まない', () => {
    const { value, session } = issue();
    const [payloadSegment, signatureSegment] = value.split('.');
    const decoded = Buffer.from(payloadSegment, 'base64url').toString('utf8');

    expect(value.split('.')).toHaveLength(2);
    expect(decoded).toBe(
      JSON.stringify({ purpose: 'order_status', orderId: ORDER_ID, tokenHashPrefix: hashPrefix(TOKEN), iat: IAT, exp: IAT + 86400 }),
    );
    expect(Object.keys(session)).toEqual(['purpose', 'orderId', 'tokenHashPrefix', 'iat', 'exp']);
    expect(session).toEqual(JSON.parse(decoded));
    expect(signatureSegment).toBe(signature(payloadSegment));
    expect(Buffer.from(signatureSegment, 'base64url')).toHaveLength(32);
    expect(value.includes(TOKEN)).toBe(false);
    expect(decoded.includes(TOKEN)).toBe(false);
  });

  test('発行した値は同じ注文・トークン・DB期限で読める', () => {
    const { value, session } = issue();

    expect(read(value)).toEqual(session);
  });

  test('発行できない入力（注文・トークン・期限が不正）は固定のエラーで止まり、値を作らない', () => {
    const inputs: Array<Partial<IssueInput>> = [
      { orderId: 'order-1' },
      { orderId: '' },
      { token: TOKEN.slice(0, 42) },
      { token: `${TOKEN.slice(0, 42)}/` },
      { verifyUntil: 'not-a-date' },
      { verifyUntil: '' },
    ];

    for (const overrides of inputs) {
      expect(() => issue(overrides)).toThrow(OrderStatusSessionError);
    }
  });
});

describe('readOrderStatusSession', () => {
  test('署名とpurposeと注文とトークンと時刻を全て照合する', () => {
    const { value } = issue();
    const [payloadSegment, signatureSegment] = value.split('.');
    const flipFirst = (segment: string) => `${segment[0] === 'A' ? 'B' : 'A'}${segment.slice(1)}`;

    const validRead = read(value);
    // 偽造の道具が正しい形を作れていること（以下の異常が「道具の誤り」で落ちていないことの対照）
    const control = read(forge(PAYLOAD));
    expect(control?.orderId).toBe(ORDER_ID);

    const invalid: Array<{ name: string; value: string | undefined; overrides?: Partial<ReadInput> }> = [
      { name: 'payload改変', value: `${base64url(JSON.stringify({ ...PAYLOAD, exp: IAT + 7200 }))}.${signatureSegment}` },
      { name: '署名改変', value: `${payloadSegment}.${flipFirst(signatureSegment)}` },
      { name: '署名が短い', value: `${payloadSegment}.${signatureSegment.slice(0, -1)}` },
      { name: '署名が長い', value: `${payloadSegment}.${signatureSegment}A` },
      { name: '署名が空', value: `${payloadSegment}.` },
      { name: 'payloadの不正base64url', value: `${payloadSegment}*.${signatureSegment}` },
      { name: '署名の不正base64url', value: `${payloadSegment}.${signatureSegment.slice(0, -1)}=` },
      { name: 'パディング付きpayload', value: `${payloadSegment}=.${signatureSegment}` },
      { name: '余分なsegment', value: `${value}.${signatureSegment}` },
      { name: '末尾のドット', value: `${value}.` },
      { name: 'segmentが1つ', value: payloadSegment },
      { name: '別の鍵の署名', value: forge(PAYLOAD, OTHER_SECRET) },
      { name: '違うpurpose', value: forge({ ...PAYLOAD, purpose: 'login_2fa' }) },
      { name: '違う注文（署名は正しい）', value: forge({ ...PAYLOAD, orderId: OTHER_ORDER_ID }) },
      { name: '違うtoken（署名は正しい）', value: forge({ ...PAYLOAD, tokenHashPrefix: hashPrefix(OTHER_TOKEN) }) },
      { name: '読む側の注文が違う', value: forge(PAYLOAD), overrides: { orderId: OTHER_ORDER_ID } },
      { name: '読む側のトークンが違う', value: forge(PAYLOAD), overrides: { token: OTHER_TOKEN } },
      { name: '未来のiat', value: forge({ ...PAYLOAD, iat: IAT + 1 }) },
      { name: '小数のiat', value: forge({ ...PAYLOAD, iat: IAT - 0.5 }) },
      { name: '小数のexp', value: forge({ ...PAYLOAD, exp: IAT + 3600.5 }) },
      { name: 'expが24時間を超える', value: forge({ ...PAYLOAD, exp: IAT + 86401 }) },
      { name: 'expがiatと同じ', value: forge({ ...PAYLOAD, exp: IAT }) },
      { name: 'expが現在と同時刻', value: forge({ ...PAYLOAD, iat: IAT - 3600, exp: IAT }) },
      { name: '期限切れ', value: forge({ ...PAYLOAD, iat: IAT - 7200, exp: IAT - 3600 }) },
      { name: '時刻が文字列', value: forge({ ...PAYLOAD, iat: String(IAT) }) },
      { name: 'DBの期限がNULL', value: forge(PAYLOAD), overrides: { verifyUntil: null } },
      { name: 'DBの期限が短縮された', value: forge(PAYLOAD), overrides: { verifyUntil: iso(1800) } },
      { name: 'DBの期限が過ぎた', value: forge(PAYLOAD), overrides: { verifyUntil: iso(-1) } },
      { name: 'DBの期限が現在と同時刻', value: forge(PAYLOAD), overrides: { verifyUntil: iso(0) } },
      { name: 'DBの期限が読めない値', value: forge(PAYLOAD), overrides: { verifyUntil: 'not-a-date' } },
      { name: '異常JSON（文字列）', value: forge('not json') },
      { name: '異常JSON（null）', value: forge('null') },
      { name: '異常JSON（配列）', value: forge('[]') },
      { name: '異常JSON（空のオブジェクト）', value: forge({}) },
      {
        name: '異常JSON（キー不足）',
        value: forge({ purpose: PAYLOAD.purpose, orderId: PAYLOAD.orderId, iat: PAYLOAD.iat, exp: PAYLOAD.exp }),
      },
      { name: '異常JSON（余分なキー）', value: forge({ ...PAYLOAD, extra: 1 }) },
      { name: 'ハッシュの先頭が大文字', value: forge({ ...PAYLOAD, tokenHashPrefix: hashPrefix(TOKEN).toUpperCase() }) },
      { name: 'ハッシュの先頭が短い', value: forge({ ...PAYLOAD, tokenHashPrefix: hashPrefix(TOKEN).slice(0, 15) }) },
      { name: '注文がUUIDでない', value: forge({ ...PAYLOAD, orderId: 'order-1' }), overrides: { orderId: 'order-1' } },
      { name: '空文字', value: '' },
      { name: '未設定', value: undefined },
    ];

    const invalidReads = invalid.map(({ value: cookie, overrides }) => read(cookie, overrides));
    const accepted = invalid.filter((_, index) => invalidReads[index] !== null).map(({ name }) => name);

    expect(validRead?.orderId).toBe(ORDER_ID);
    expect(accepted).toEqual([]);
    expect(invalidReads.every((entry) => entry === null)).toBe(true);
  });

  test('境界の値は受ける（対照）。iatは現在以前、expは現在より後、24時間ちょうど、DB期限はexp以後', () => {
    const accepted: Array<[string, ReturnType<typeof read>]> = [
      ['iatが現在と同時刻', read(forge({ ...PAYLOAD, iat: IAT, exp: IAT + 1 }), { verifyUntil: iso(1) })],
      ['iatが過去', read(forge({ ...PAYLOAD, iat: IAT - 10, exp: IAT + 1 }), { verifyUntil: iso(1) })],
      ['24時間ちょうど', read(forge({ ...PAYLOAD, exp: IAT + 86400 }), { verifyUntil: iso(86400) })],
      ['DB期限がexpと同じ秒', read(forge(PAYLOAD), { verifyUntil: iso(3600) })],
      ['DB期限がexpの秒の端数つき', read(forge(PAYLOAD), { verifyUntil: new Date((IAT + 3600) * 1000 + 999).toISOString() })],
      ['UUIDの大文字', read(forge({ ...PAYLOAD, orderId: ORDER_ID.toUpperCase() }), { orderId: ORDER_ID.toUpperCase() })],
    ];

    expect(accepted.filter(([, session]) => session === null).map(([name]) => name)).toEqual([]);
  });

  test('2注文へ同じCookie値を移しても拒否する', () => {
    const a = issue({ orderId: ORDER_ID, token: TOKEN }).value;
    const b = issue({ orderId: OTHER_ORDER_ID, token: OTHER_TOKEN }).value;

    expect(read(a)).not.toBeNull();
    expect(read(b, { orderId: OTHER_ORDER_ID, token: OTHER_TOKEN })).not.toBeNull();
    expect(read(a, { orderId: OTHER_ORDER_ID, token: OTHER_TOKEN })).toBeNull();
    expect(read(b, { orderId: ORDER_ID, token: TOKEN })).toBeNull();
    expect(read(a, { orderId: OTHER_ORDER_ID, token: TOKEN })).toBeNull();
    expect(read(a, { orderId: ORDER_ID, token: OTHER_TOKEN })).toBeNull();
  });

  test('24時間とDB期限の早い方を秒で使い同時刻は失効', () => {
    const expirations = [issue({ verifyUntil: FAR }).session.exp, issue({ verifyUntil: iso(3600) }).session.exp];
    const { value } = issue({ verifyUntil: iso(3600) });
    // DB の期限がその後に延びても、発行済みの値の exp は延びない
    const atExpiry = read(value, { now: at(3600), verifyUntil: FAR });

    expect(expirations).toEqual([IAT + 86400, IAT + 3600]);
    expect(atExpiry).toBeNull();
    expect(read(value, { now: at(3599), verifyUntil: FAR })).not.toBeNull();
  });

  test('24時間を超えては有効にならない（DB期限が21日先でも）', () => {
    const { value, session } = issue({ verifyUntil: FAR });

    expect(session.exp - session.iat).toBe(86400);
    expect(read(value, { now: at(86399) })).not.toBeNull();
    expect(read(value, { now: at(86400) })).toBeNull();
  });

  test('秒の端数は切り捨てる。発行時刻もDB期限も秒に直してから比べる', () => {
    const withFraction = new Date(NOW.getTime() + 900);
    const { session } = issue({ now: withFraction, verifyUntil: new Date(NOW.getTime() + 3_600_900).toISOString() });

    expect(session.iat).toBe(IAT);
    expect(session.exp).toBe(IAT + 3600);
  });

  test('発行時にDB期限が今と同じ秒以前なら発行しない', () => {
    const untils = [iso(0), iso(-60), new Date(NOW.getTime() + 999).toISOString()];

    for (const verifyUntil of untils) {
      expect(() => issue({ verifyUntil })).toThrow(OrderStatusSessionError);
    }
    // 1秒先なら発行でき、expはその1秒先
    expect(issue({ verifyUntil: iso(1) }).session.exp).toBe(IAT + 1);
  });

  test('専用鍵を優先し無ければJWT_SECRET、両方無ければ発行しない', () => {
    const signedWith = (value: string, secret: string) => {
      const [segment, actual] = value.split('.');
      return actual === signature(segment, secret);
    };
    const keySelectionChecks: boolean[] = [];

    setEnv('ORDER_STATUS_SESSION_SECRET', SECRET);
    setEnv('JWT_SECRET', JWT_SECRET_VALUE);
    const dedicated = issue().value;
    keySelectionChecks.push(signedWith(dedicated, SECRET) && !signedWith(dedicated, JWT_SECRET_VALUE));

    setEnv('ORDER_STATUS_SESSION_SECRET', undefined);
    const fallback = issue().value;
    keySelectionChecks.push(signedWith(fallback, JWT_SECRET_VALUE) && !signedWith(fallback, SECRET));

    setEnv('JWT_SECRET', undefined);
    let refused = false;
    try {
      issue();
    } catch (error) {
      refused = error instanceof OrderStatusSessionError;
    }
    keySelectionChecks.push(refused);

    expect(keySelectionChecks).toEqual([true, true, true]);
  });

  test('空文字の鍵は無いものとして扱い、次の鍵へ進む。両方空なら発行しない', () => {
    setEnv('ORDER_STATUS_SESSION_SECRET', '');
    setEnv('JWT_SECRET', JWT_SECRET_VALUE);
    const [segment, actual] = issue().value.split('.');
    expect(actual).toBe(signature(segment, JWT_SECRET_VALUE));

    setEnv('JWT_SECRET', '');
    expect(() => issue()).toThrow(OrderStatusSessionError);
  });

  test('鍵は呼び出しのたびに読む（読み込み時に固定しない）', () => {
    const first = issue().value;
    expect(read(first)).not.toBeNull();

    setEnv('ORDER_STATUS_SESSION_SECRET', OTHER_SECRET);
    expect(read(first)).toBeNull();
    const second = issue().value;
    const [segment, actual] = second.split('.');
    expect(actual).toBe(signature(segment, OTHER_SECRET));
    expect(read(second)).not.toBeNull();
  });

  test('鍵が無い時は、値が来ていれば確かめられないので固定のエラーで止め、値が無ければ鍵を要らずnull', () => {
    const { value } = issue();
    setEnv('ORDER_STATUS_SESSION_SECRET', undefined);
    setEnv('JWT_SECRET', undefined);

    expect(() => read(value)).toThrow(OrderStatusSessionError);
    expect(read(undefined)).toBeNull();
    expect(read('')).toBeNull();
    // 形が崩れた値は、鍵を見る前にnull
    expect(read('not.a.cookie')).toBeNull();
  });

  test('固定のエラーの文に、鍵・トークン・注文を入れない', () => {
    setEnv('ORDER_STATUS_SESSION_SECRET', undefined);
    setEnv('JWT_SECRET', undefined);

    const error = (() => {
      try {
        issue();
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('should have thrown');
    })();

    expect(error.message).toBe('order status session unavailable');
    for (const secret of [SECRET, OTHER_SECRET, JWT_SECRET_VALUE, TOKEN, ORDER_ID]) {
      expect(error.message.includes(secret)).toBe(false);
    }
  });
});

describe('orderStatusCookieOptions', () => {
  test('path/strict/httpOnly/secure/maxAge/expires を持ち、Domain は指定しない', () => {
    const { session } = issue({ verifyUntil: iso(7200) });

    const options = orderStatusCookieOptions(TOKEN, session);

    expect(Object.keys(options).sort()).toEqual(['expires', 'httpOnly', 'maxAge', 'path', 'sameSite', 'secure']);
    expect(options).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: `/api/order-status/${TOKEN}`,
      maxAge: 7200,
      expires: new Date((IAT + 7200) * 1000),
    });
    expect(options).not.toHaveProperty('domain');
    expect(options.maxAge).toBe(session.exp - session.iat);
    expect(options.expires.getTime()).toBe(session.exp * 1000);
  });

  test('24時間の上限なら maxAge は 86400 秒', () => {
    const { session } = issue({ verifyUntil: FAR });

    expect(orderStatusCookieOptions(TOKEN, session).maxAge).toBe(86400);
  });

  test('secure は本番だけ true', () => {
    const { session } = issue();
    const secureIn = (nodeEnv: string) => {
      setEnv('NODE_ENV', nodeEnv);
      return orderStatusCookieOptions(TOKEN, session).secure;
    };

    expect([secureIn('production'), secureIn('development'), secureIn('test')]).toEqual([true, false, false]);
  });

  test('トークンの形が違えば path を作らず固定のエラー', () => {
    const { session } = issue();

    expect(() => orderStatusCookieOptions(`${TOKEN.slice(0, 42)};`, session)).toThrow(OrderStatusSessionError);
    expect(() => orderStatusCookieOptions('', session)).toThrow(OrderStatusSessionError);
  });
});
