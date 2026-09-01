const DEFAULT_SITE_URL = 'http://localhost:3000';

function normalizeOrigin(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }

  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

function parseAllowedOrigins(): Set<string> {
  const configured = process.env.APP_ALLOWED_ORIGINS;
  const fallback = getSiteUrl();
  const defaults = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.BASE_URL,
    process.env.NEXT_PUBLIC_VERCEL_URL ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}` : null,
    fallback,
  ];

  const rawEntries = [
    ...(configured ? configured.split(',') : []),
    ...defaults,
  ];

  const origins = new Set<string>();
  for (const entry of rawEntries) {
    const normalized = normalizeOrigin(entry?.trim() ?? null);
    if (normalized) {
      origins.add(normalized);
    }
  }

  if (origins.size === 0) {
    origins.add(DEFAULT_SITE_URL);
  }

  return origins;
}

function shouldTrustForwardedHeaders(): boolean {
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    return true;
  }

  // Vercel runtime はプラットフォーム管理の proxy ヘッダを利用できる。
  return process.env.VERCEL === '1';
}

function buildCandidateOrigin(proto: string | null, host: string | null): string | null {
  if (!host) {
    return null;
  }

  const resolvedProto = proto === 'https' || proto === 'http' ? proto : 'https';
  return normalizeOrigin(`${resolvedProto}://${host}`);
}

export function getSiteUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_BASE_URL || process.env.BASE_URL || process.env.NEXT_PUBLIC_VERCEL_URL;

  if (envUrl) {
    return envUrl.startsWith('http') ? envUrl : `https://${envUrl}`;
  }

  return DEFAULT_SITE_URL;
}

export function getRequestOrigin(request: Request): string {
  const allowedOrigins = parseAllowedOrigins();
  const siteOrigin = normalizeOrigin(getSiteUrl()) ?? DEFAULT_SITE_URL;
  const requestOrigin = normalizeOrigin(request.url);

  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    return requestOrigin;
  }

  const host = request.headers.get('host');
  const hostBasedOrigin = buildCandidateOrigin(requestOrigin ? new URL(requestOrigin).protocol.replace(':', '') : null, host);
  if (hostBasedOrigin && allowedOrigins.has(hostBasedOrigin)) {
    return hostBasedOrigin;
  }

  if (shouldTrustForwardedHeaders()) {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const forwardedHost = request.headers.get('x-forwarded-host');
    const forwardedOrigin = buildCandidateOrigin(forwardedProto, forwardedHost);
    if (forwardedOrigin && allowedOrigins.has(forwardedOrigin)) {
      return forwardedOrigin;
    }
  }

  return siteOrigin;
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

/**
 * オリジンが許可リストに含まれるか。
 *
 * CSRF の Origin 検査で使う。OWASP CSRF Cheat Sheet は「**既知の**ターゲットオリジンと
 * 照合する」ことを求めており、期待値をリクエストヘッダ（x-forwarded-host 等）から
 * 組み立てると、クライアントが指定した値を自分で信頼することになり検査が循環する。
 */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return false;
  }

  return parseAllowedOrigins().has(normalized);
}

/**
 * 許可オリジンが環境変数で明示されているか。
 *
 * 未設定だと parseAllowedOrigins は localhost:3000 だけを返すため、本番で
 * すべての状態変更 API が 403 になる。設定漏れで機能停止させないよう、
 * 呼び出し側はこれが false のときだけリクエスト由来のオリジンへ退避する。
 * Origin 検査はブラウザからは迂回できない（X-Forwarded-Host はカスタムヘッダなので
 * クロスサイトの fetch は preflight が必要になり、フォーム POST では付けられない）ため、
 * 退避しても実害は無いが、設定は入れること。
 */
export function hasExplicitOriginConfig(): boolean {
  return Boolean(
    process.env.APP_ALLOWED_ORIGINS ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.BASE_URL ||
      process.env.NEXT_PUBLIC_VERCEL_URL,
  );
}
