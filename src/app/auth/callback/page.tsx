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
        console.log('[OAuth] Callback started, code:', code ? 'present' : 'missing');

        // 既にセッションがある場合はそのまま進む
        const existing = await supabase.auth.getSession();
        console.log('[OAuth] Existing session:', existing.data.session ? 'YES' : 'NO');
        if (existing.data.session) {
          console.log('[OAuth] Session already exists, redirecting to:', next);
          if (!cancelled) router.replace(next);
          return;
        }

        // PKCE の code がある場合は exchange
        if (code) {
          console.log('[OAuth] Exchanging code for session...');
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          console.log('[OAuth] Exchange result:', error ? 'ERROR' : 'SUCCESS');
          if (error) {
            console.error('[OAuth] exchangeCodeForSession error', error);
            if (!cancelled) setMessage('認証に失敗しました。もう一度お試しください。');
            return;
          }

          if (!data.session) {
            console.error('[OAuth] No session after exchange');
            if (!cancelled) setMessage('セッションの取得に失敗しました。');
            return;
          }

          console.log('[OAuth] Session created successfully, redirecting to:', next);
          // Session 作成後、Cookies を確認
          const parsed = localStorage.getItem('supabase.auth.token');
          if (parsed) {
            const token = JSON.parse(parsed);
            console.log('[OAuth] Token stored:', token.access_token?.substring(0, 30));
          }

          // URL から code を消してクリーンに遷移
          if (!cancelled) router.replace(next);
          return;
        }

        // code が無い場合はエラー
        if (!cancelled) setMessage('認証情報が見つかりませんでした。');
      } catch (e) {
        console.error('[OAuth] callback error', e);
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
