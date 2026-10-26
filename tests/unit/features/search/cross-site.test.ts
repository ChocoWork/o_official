jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers ?? {}),
      json: async () => body,
    }),
  },
}));

import { rejectCrossSiteFetch } from '@/features/search/lib/cross-site';

function requestWith(headers: Record<string, string>) {
  return new Request('http://localhost/api/search?q=coat', { headers });
}

describe('rejectCrossSiteFetch', () => {
  it.each([
    ['見出し無し', {}],
    ['空文字', { 'sec-fetch-site': '' }],
    ['same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['none', { 'sec-fetch-site': 'none' }],
  ])('DD-SEARCH-010 %s は通す（null）', (_label, headers) => {
    expect(rejectCrossSiteFetch(requestWith(headers))).toBeNull();
  });

  it.each(['cross-site', 'same-site', 'Cross-Site', 'foo'])(
    'DD-SEARCH-010 sec-fetch-site: %s は 403 { error: Forbidden } と private, no-store で断る',
    async (value) => {
      const response = rejectCrossSiteFetch(requestWith({ 'sec-fetch-site': value }));

      expect(response).not.toBeNull();
      expect(response!.status).toBe(403);
      expect(await response!.json()).toEqual({ error: 'Forbidden' });
      expect(response!.headers.get('Cache-Control')).toBe('private, no-store');
    },
  );
});
