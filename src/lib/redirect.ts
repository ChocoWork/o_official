const DEFAULT_SITE_URL = 'http://localhost:3000';

export function getRequestOrigin(request: Request): string {
  const proto = request.headers.get('x-forwarded-proto') || (request.url.startsWith('https') ? 'https' : 'http');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');

  if (host) {
    return `${proto}://${host}`;
  }

  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_VERCEL_URL;
  if (envUrl) {
    return envUrl.startsWith('http') ? envUrl : `https://${envUrl}`;
  }

  return DEFAULT_SITE_URL;
}

export function sanitizeRedirectPath(input: string | null | undefined, fallbackPath: string): string {
  if (!input) return fallbackPath;

  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return fallbackPath;
  if (trimmed.startsWith('//')) return fallbackPath;
  if (trimmed.includes('\\')) return fallbackPath;
  if (trimmed.startsWith('/\\')) return fallbackPath;

  return trimmed;
}
