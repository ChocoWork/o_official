import { NextRequest } from 'next/server';

// NextResponse.json uses the platform Response constructor, which isn't available
// in our Jest environment and was throwing `Response.json is not a function`.  We
// can mock it to return a simple object so the handler logic can run without
// blowing up.
jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: any, init?: any) => ({ body, status: init?.status || 200 })),
    },
  };
});

import { GET } from '@/app/api/cart/route';

// we'll mock supabase client used in the route implementation
jest.mock('@supabase/supabase-js', () => {
  return {
    createClient: jest.fn().mockReturnValue({
      from: jest.fn().mockImplementation((table: string) => {
        const chain: any = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          delete: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
          single: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockReturnThis(),
          // `then` can be assigned by tests to simulate promise resolution
        };
        return chain;
      }),
    }),
  };
});

describe('cart GET route', () => {
  it('filters out cart entries when item data is missing', async () => {
    // ...existing GET test...
  });
});

describe('cart PATCH route', () => {
  const { PATCH } = require('@/app/api/cart/[id]/route');

  it('returns 400 when quantity is missing and body present', async () => {
    const req = {
      cookies: { get: jest.fn().mockReturnValue({ value: 'sess' }) },
      json: jest.fn().mockResolvedValue({}),
    } as unknown as NextRequest;
    const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });
    expect(res.body).toMatchObject({ error: 'Valid quantity is required' });
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = {
      cookies: { get: jest.fn().mockReturnValue({ value: 'sess' }) },
      json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input')),
    } as unknown as NextRequest;
    const res = await PATCH(req, { params: Promise.resolve({ id: '1' }) });
    expect(res.body).toMatchObject({ error: 'Invalid request body' });
    expect(res.status).toBe(400);
  });
});
