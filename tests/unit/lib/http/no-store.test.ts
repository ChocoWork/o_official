/** @jest-environment node */
import { NextResponse } from 'next/server';
import { NO_STORE_CACHE_CONTROL, withNoStore } from '@/lib/http/no-store';

describe('DD-STOCKIST-034 withNoStore', () => {
  it('DD-STOCKIST-034 Cache-Control を正確に private, no-store にし、状態・本文・Retry-After を変えず同じ参照を返す', async () => {
    const original = new NextResponse(JSON.stringify({ a: 1 }), {
      status: 429,
      headers: { 'Retry-After': '30' },
    });

    const wrapped = withNoStore(original);

    expect(wrapped).toBe(original);
    expect(NO_STORE_CACHE_CONTROL).toBe('private, no-store');
    expect(wrapped.headers.get('Cache-Control')).toBe('private, no-store');
    expect(wrapped.headers.get('Retry-After')).toBe('30');
    expect(wrapped.status).toBe(429);
    expect(await wrapped.json()).toEqual({ a: 1 });
  });

  it('DD-STOCKIST-034 既に Cache-Control がある応答は置き換えられ、s-maxage が残らない', () => {
    const original = new NextResponse(JSON.stringify({ ok: true }), {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate' },
    });

    const wrapped = withNoStore(original);

    expect(wrapped.headers.get('Cache-Control')).toBe('private, no-store');
    expect(wrapped.headers.get('Cache-Control')).not.toContain('s-maxage');
  });

  it('DD-STOCKIST-034 Set-Cookie を持つ応答の Cookie が消えない', () => {
    const original = new NextResponse(JSON.stringify({ ok: true }));
    original.cookies.set('csrf_token', 'abc', { path: '/' });

    const wrapped = withNoStore(original);

    expect(wrapped.headers.get('set-cookie')).toContain('csrf_token=abc');
    expect(wrapped.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('DD-STOCKIST-034 NextResponse でない Response も包める', async () => {
    const original = new Response(JSON.stringify({ b: 2 }), { status: 503 });

    const wrapped = withNoStore(original);

    expect(wrapped.headers.get('Cache-Control')).toBe('private, no-store');
    expect(wrapped.status).toBe(503);
    expect(await wrapped.json()).toEqual({ b: 2 });
  });
});
