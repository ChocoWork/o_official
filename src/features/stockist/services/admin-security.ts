import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { csrfCookieName, cookieOptionsForCsrf } from '@/lib/cookie';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';

const STOCKIST_ADMIN_RATE_LIMIT_WINDOW_SECONDS = 600;
const STOCKIST_ADMIN_READ_LIMIT = 120;
const STOCKIST_ADMIN_MUTATION_LIMIT = 20;

type RotatedCsrfToken = {
  rotatedCsrfToken: string;
};

type MockCsrfDenyResponse = {
  status: number;
  _body: unknown;
  headers?: Headers | Record<string, string>;
};

function hasMockCsrfBody(value: unknown): value is MockCsrfDenyResponse {
  return typeof value === 'object' && value !== null && 'status' in value && '_body' in value;
}

export function hasRotatedCsrfToken(value: unknown): value is RotatedCsrfToken {
  return typeof value === 'object' && value !== null && 'rotatedCsrfToken' in value;
}

export async function requireAdminStockistCsrf(): Promise<unknown> {
  return requireCsrfOrDeny();
}

export function toCsrfDenyResponse(value: unknown): Response | null {
  if (!value || hasRotatedCsrfToken(value)) {
    return null;
  }

  if (value instanceof Response) {
    return value;
  }

  if (!hasMockCsrfBody(value)) {
    return null;
  }

  const response = NextResponse.json(value._body, { status: value.status });
  if (value.headers instanceof Headers) {
    value.headers.forEach((headerValue, headerName) => {
      response.headers.set(headerName, headerValue);
    });
  } else if (value.headers) {
    for (const [headerName, headerValue] of Object.entries(value.headers)) {
      response.headers.set(headerName, headerValue);
    }
  }

  return response;
}

export function applyRotatedCsrfCookie(response: NextResponse, csrfResult: unknown) {
  if (!hasRotatedCsrfToken(csrfResult)) {
    return;
  }

  response.cookies.set({
    name: csrfCookieName,
    value: csrfResult.rotatedCsrfToken,
    ...cookieOptionsForCsrf(0),
  });
}

async function enforceStockistAdminRateLimit(
  request: Request,
  actorId: string,
  endpoint: string,
  limit: number,
) {
  const ipRateLimitResponse = await enforceRateLimit({
    request,
    endpoint,
    limit,
    windowSeconds: STOCKIST_ADMIN_RATE_LIMIT_WINDOW_SECONDS,
  });
  if (ipRateLimitResponse) {
    return ipRateLimitResponse;
  }

  return enforceRateLimit({
    request,
    endpoint,
    limit,
    windowSeconds: STOCKIST_ADMIN_RATE_LIMIT_WINDOW_SECONDS,
    subject: actorId,
  });
}

export async function enforceAdminStockistReadRateLimit(request: Request, actorId: string) {
  return enforceStockistAdminRateLimit(request, actorId, 'admin:stockists:read', STOCKIST_ADMIN_READ_LIMIT);
}

export async function enforceAdminStockistMutationRateLimit(request: Request, actorId: string) {
  return enforceStockistAdminRateLimit(request, actorId, 'admin:stockists:mutation', STOCKIST_ADMIN_MUTATION_LIMIT);
}