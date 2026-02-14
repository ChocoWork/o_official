"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';

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

        // 既にセッションがある場合はそのまま進む
        const existing = await supabase.auth.getSession();
        if (existing.data.session) {
          if (!cancelled) router.replace(next);
          return;
        }

        // PKCE の code がある場合は exchange
        if (code) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            console.error('exchangeCodeForSession error', error);
            if (!cancelled) setMessage('認証に失敗しました。もう一度お試しください。');
            return;
          }

          if (!data.session) {
            if (!cancelled) setMessage('セッションの取得に失敗しました。');
            return;
          }

          // URL から code を消してクリーンに遷移
          if (!cancelled) router.replace(next);
          return;
        }

        // code が無い場合はエラー
        if (!cancelled) setMessage('認証情報が見つかりませんでした。');
      } catch (e) {
        console.error('OAuth callback error', e);
        if (!cancelled) setMessage('内部エラーが発生しました。');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, searchParams, next]);

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-xl mx-auto font-brand">
        <h1 className="text-xl tracking-widest mb-4">OAuth</h1>
        <p className="text-sm text-[#474747]">{message}</p>
      </div>
    </main>
  );
}
