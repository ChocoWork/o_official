"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function VerifiedPage() {
  const [status, setStatus] = useState<'checking' | 'success' | 'failed' | 'need_action'>('checking');
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    (async () => {
      // Try to auto-login using credentials saved during signUp
      try {
        const raw = sessionStorage.getItem('pending_signup');
        if (!raw) {
          setStatus('need_action');
          setMessage('検証が完了しました。ログインしてください。');
          return;
        }

        const obj = JSON.parse(raw);
        // expiration: 1 hour
        if (!obj || !obj.email || !obj.password || Date.now() - obj.ts > 1000 * 60 * 60) {
          sessionStorage.removeItem('pending_signup');
          setStatus('need_action');
          setMessage('検証は完了しました。ログイン情報の有効期限が切れました。ログインしてください。');
          return;
        }

        setMessage('検証完了。自動ログインを試みます…');

        // POST credentials to server-side login which sets HttpOnly refresh cookie
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: obj.email, password: obj.password }),
        });

        sessionStorage.removeItem('pending_signup');

        if (!resp.ok) {
          console.error('Auto login failed', await resp.text());
          setStatus('failed');
          setMessage('自動ログインに失敗しました。手動でログインしてください。');
          return;
        }

        setStatus('success');
        setMessage('自動ログインに成功しました。リダイレクトします…');
        setTimeout(() => router.push('/'), 800);
      } catch (e) {
        console.error(e);
        setStatus('need_action');
        setMessage('検証は完了しました。ログインしてください。');
      }
    })();
  }, [router]);

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-xl mb-4">メール確認</h1>
      <p className="mb-4">{message}</p>
      {status === 'need_action' ? (
        <div>
          <a href="/login" className="text-blue-600">ログインページへ</a>
        </div>
      ) : null}
    </div>
  );
}
