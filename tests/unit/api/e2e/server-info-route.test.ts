jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
        status: init?.status ?? 200,
        body,
        headers: init?.headers ?? {},
      }),
    },
  };
});

import { GET } from '@/app/api/e2e/server-info/route';

describe('GET /api/e2e/server-info', () => {
  const original = process.env.E2E_SERVER_FINGERPRINT;

  afterEach(() => {
    if (original === undefined) delete process.env.E2E_SERVER_FINGERPRINT;
    else process.env.E2E_SERVER_FINGERPRINT = original;
  });

  it('E2E 用の印が無い起動（本番・普段の開発）では 404 を返し、何も明かさない', () => {
    delete process.env.E2E_SERVER_FINGERPRINT;
    expect(GET()).toEqual({ status: 404, body: { error: 'Not found' }, headers: {} });
  });

  it('E2E 用に起動したアプリは印を返し、保存させない', () => {
    process.env.E2E_SERVER_FINGERPRINT = 'abc123';
    expect(GET()).toEqual({
      status: 200,
      body: { fingerprint: 'abc123' },
      headers: { 'Cache-Control': 'no-store' },
    });
  });
});
