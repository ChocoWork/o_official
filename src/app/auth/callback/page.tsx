"use client";

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black align-[-2px]"
    />
  );
}

function OAuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = useMemo(() => {
    const raw = searchParams.get('next') || '/auth/verified';
    return raw.startsWith('/') ? raw : '/auth/verified';
  }, [searchParams]);

  const [message, setMessage] = useState<string>('サインインしています…');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const code = searchParams.get('code');

        if (code) {
          const redirectParams = new URLSearchParams(searchParams.toString());
          window.location.replace(`/api/auth/oauth/callback?${redirectParams.toString()}`);
          return;
        }

        const response = await fetch('/api/auth/me', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        });
        const body: unknown = await response.json().catch(() => null);
        const authenticated =
          response.ok &&
          typeof body === 'object' &&
          body !== null &&
          'authenticated' in body &&
          (body as { authenticated?: unknown }).authenticated === true;

        if (authenticated) {
          if (!cancelled) router.replace(next);
          return;
        }

        if (!cancelled) {
          setMessage('認証を完了できませんでした。ログイン画面からもう一度お試しください。');
          setFailed(true);
        }
      } catch (e) {
        console.error('OAuth callback page error', e);
        if (!cancelled) {
          setMessage('内部エラーが発生しました。');
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, searchParams, next]);

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-xl mx-auto">
        <h1 className="mb-4">{failed ? 'サインインできませんでした' : 'サインインしています…'}</h1>
        <p className="text-sm text-[#474747] flex items-center gap-2" role="status" aria-live="polite">
          {!failed ? <Spinner /> : null}
          {message}
        </p>
        {failed ? (
          <Link
            href="/login"
            className="mt-4 inline-block text-sm underline underline-offset-4 hover:text-[#474747] transition-colors"
          >
            ログインに戻る
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="pb-10 sm:pb-14 px-6 lg:px-12">
          <div className="max-w-xl mx-auto">
            <h1 className="mb-4">サインインしています…</h1>
            <p className="text-sm text-[#474747] flex items-center gap-2" role="status" aria-live="polite">
              <Spinner />
              認証処理中…
            </p>
          </div>
        </div>
      }
    >
      <OAuthCallbackContent />
    </Suspense>
  );
}
