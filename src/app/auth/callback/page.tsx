"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function OAuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = useMemo(() => {
    const raw = searchParams.get('next') || '/auth/verified';
    return raw.startsWith('/') ? raw : '/auth/verified';
  }, [searchParams]);

  const [message, setMessage] = useState<string>('認証処理中…');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const code = searchParams.get('code');
        const state = searchParams.get('state');

        if (code && state) {
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
        }
      } catch (e) {
        console.error('OAuth callback page error', e);
        if (!cancelled) setMessage('内部エラーが発生しました。');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, searchParams, next]);

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-xl mx-auto font-brand">
        <h1 className="text-xl tracking-widest mb-4">OAuth</h1>
        <p className="text-sm text-[#474747]">{message}</p>
      </div>
    </div>
  );
}
