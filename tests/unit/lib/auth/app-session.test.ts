// DD-AUTH-039: アプリの session への結び付けの旗と、GoTrue の session_id の読み取り。

import { isAppSessionRequired, readAuthSessionId } from '@/lib/auth/app-session';

const SID = '4c36ef0b-0332-42d8-b210-3326fc20c240';

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('isAppSessionRequired', () => {
  const original = process.env.AUTH_REQUIRE_APP_SESSION;

  afterEach(() => {
    if (original === undefined) delete process.env.AUTH_REQUIRE_APP_SESSION;
    else process.env.AUTH_REQUIRE_APP_SESSION = original;
  });

  test.each([undefined, '', 'on', '1', 'true', 'yes', 'ON', 'anything'])(
    'DD-AUTH-039 AUTH_REQUIRE_APP_SESSION=%p は有効（既定で有効）',
    (value) => {
      if (value === undefined) delete process.env.AUTH_REQUIRE_APP_SESSION;
      else process.env.AUTH_REQUIRE_APP_SESSION = value;
      expect(isAppSessionRequired()).toBe(true);
    },
  );

  test.each(['off', 'OFF', 'Off', '0', 'false', 'FALSE', ' False '])(
    'DD-AUTH-039 AUTH_REQUIRE_APP_SESSION=%p は無効',
    (value) => {
      process.env.AUTH_REQUIRE_APP_SESSION = value;
      expect(isAppSessionRequired()).toBe(false);
    },
  );
});

describe('readAuthSessionId', () => {
  test('DD-AUTH-039 uuid の形の session_id を返す', () => {
    expect(readAuthSessionId(jwt({ sub: 'u', session_id: SID }))).toBe(SID);
  });

  test('DD-AUTH-039 大文字の uuid も受け、小文字にそろえる', () => {
    expect(readAuthSessionId(jwt({ session_id: SID.toUpperCase() }))).toBe(SID);
  });

  test.each([
    ['session_id が無い', jwt({ aud: 'authenticated' })],
    ['session_id が空', jwt({ session_id: '' })],
    ['session_id が uuid でない', jwt({ session_id: 'not-a-uuid' })],
    ['session_id が文字列でない', jwt({ session_id: 123 })],
    ['payload が壊れた base64', 'aaa.%%%.sig'],
    ['payload が JSON でない', `aaa.${Buffer.from('not json').toString('base64url')}.sig`],
    ['payload が配列', `aaa.${Buffer.from('[1]').toString('base64url')}.sig`],
    ['ドットが無い', 'nodots'],
    ['空文字', ''],
  ])('DD-AUTH-039 %s なら null', (_label, token) => {
    expect(readAuthSessionId(token)).toBeNull();
  });

  test.each([null, undefined])('DD-AUTH-039 %p なら null', (token) => {
    expect(readAuthSessionId(token)).toBeNull();
  });
});
