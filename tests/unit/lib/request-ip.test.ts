/**
 * @jest-environment node
 */
import { getAuditRequestContext, getClientIp } from '@/lib/request-ip';

const ENV_KEYS = ['VERCEL', 'CLIENT_IP_HEADER', 'TRUST_PROXY_HEADERS'] as const;

function req(headers: Record<string, string>): Request {
  return new Request('https://shop.example.com/api/x', { headers });
}

describe('DD-AUTH-038 getClientIp（送り元の IP は Vercel の見出しだけから取る）', () => {
  const backup: Record<string, string | undefined> = {};
  const env = process.env as Record<string, string | undefined>;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      backup[k] = env[k];
      delete env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (backup[k] === undefined) delete env[k];
      else env[k] = backup[k];
    }
  });

  describe('読む物', () => {
    it.each([
      ['VERCEL=1 + x-vercel-forwarded-for', { VERCEL: '1' }, { 'x-vercel-forwarded-for': '203.0.113.9' }, '203.0.113.9'],
      ['VERCEL=1 + x-real-ip だけ', { VERCEL: '1' }, { 'x-real-ip': '203.0.113.10' }, '203.0.113.10'],
      [
        'VERCEL=1 で両方在る時は x-vercel-forwarded-for が勝つ',
        { VERCEL: '1' },
        { 'x-vercel-forwarded-for': '203.0.113.9', 'x-real-ip': '198.51.100.1' },
        '203.0.113.9',
      ],
      [
        'CLIENT_IP_HEADER（VERCEL 無し）+ x-real-ip',
        { CLIENT_IP_HEADER: 'x-real-ip' },
        { 'x-real-ip': '198.51.100.7' },
        '198.51.100.7',
      ],
      ['IPv6', { VERCEL: '1' }, { 'x-real-ip': '2001:db8::1' }, '2001:db8::1'],
      ['前後の空白は trim する', { VERCEL: '1' }, { 'x-real-ip': '  203.0.113.9  ' }, '203.0.113.9'],
      [
        'x-forwarded-for と x-real-ip の両方が在る時は x-real-ip を返す',
        { VERCEL: '1' },
        { 'x-forwarded-for': '10.9.9.9', 'x-real-ip': '203.0.113.9' },
        '203.0.113.9',
      ],
    ])('DD-AUTH-038 %s', (_name, envs, headers, expected) => {
      Object.assign(env, envs);
      expect(getClientIp(req(headers))).toBe(expected);
    });
  });

  describe('null になる物', () => {
    it.each([
      ['VERCEL も CLIENT_IP_HEADER も無い時は x-real-ip が在っても読まない', {}, { 'x-real-ip': '203.0.113.9' }],
      [
        'VERCEL も CLIENT_IP_HEADER も無い時は x-vercel-forwarded-for が在っても読まない',
        {},
        { 'x-vercel-forwarded-for': '203.0.113.9' },
      ],
      ['CLIENT_IP_HEADER が空文字の時は旗にならない', { CLIENT_IP_HEADER: '' }, { 'x-real-ip': '203.0.113.9' }],
      ['偽の x-forwarded-for だけ（VERCEL=1 でも読まない）', { VERCEL: '1' }, { 'x-forwarded-for': '203.0.113.9' }],
      ['見出しが無い', { VERCEL: '1' }, {}],
      ['VERCEL=true（1 以外）は旗にならない', { VERCEL: 'true' }, { 'x-real-ip': '203.0.113.9' }],
      ['TRUST_PROXY_HEADERS=true だけでは読まない（redirect.ts の別の意味）', { TRUST_PROXY_HEADERS: 'true' }, { 'x-real-ip': '203.0.113.9' }],
      ['値が空', { VERCEL: '1' }, { 'x-real-ip': '   ' }],
      ['値が IP でない（foo）', { VERCEL: '1' }, { 'x-real-ip': 'foo' }],
      ['値が複数（カンマ区切り）', { VERCEL: '1' }, { 'x-real-ip': '203.0.113.9, 10.0.0.1' }],
      ['ポート付き', { VERCEL: '1' }, { 'x-real-ip': '203.0.113.9:8080' }],
      ['範囲外の数', { VERCEL: '1' }, { 'x-real-ip': '999.1.1.1' }],
      [
        'x-vercel-forwarded-for が不正なら x-real-ip が正しくても次へ進まない',
        { VERCEL: '1' },
        { 'x-vercel-forwarded-for': 'garbage', 'x-real-ip': '203.0.113.9' },
      ],
    ])('DD-AUTH-038 %s', (_name, envs, headers) => {
      Object.assign(env, envs);
      expect(getClientIp(req(headers))).toBeNull();
    });

    it('DD-AUTH-038 request が undefined なら null', () => {
      env.VERCEL = '1';
      expect(getClientIp(undefined)).toBeNull();
      expect(getClientIp()).toBeNull();
    });
  });

  describe('getAuditRequestContext', () => {
    it('DD-AUTH-038 ip は getClientIp と同じ値、user_agent は user-agent の見出し', () => {
      env.VERCEL = '1';
      expect(getAuditRequestContext(req({ 'x-real-ip': '203.0.113.9', 'user-agent': 'UA/1.0' }))).toEqual({
        ip: '203.0.113.9',
        user_agent: 'UA/1.0',
      });
    });

    it('DD-AUTH-038 user-agent が空の見出しは null にする（監査の列に空の文字を残さない）', () => {
      env.VERCEL = '1';
      expect(getAuditRequestContext(req({ 'x-real-ip': '203.0.113.9', 'user-agent': '' }))).toEqual({
        ip: '203.0.113.9',
        user_agent: null,
      });
    });

    it('DD-AUTH-038 取れない時は null のまま（"unknown" などの文字を作らない）', () => {
      expect(getAuditRequestContext(req({ 'x-forwarded-for': '203.0.113.9' }))).toEqual({
        ip: null,
        user_agent: null,
      });
    });
  });
});
