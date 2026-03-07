"use client";

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ResetRequestSchema, ResetConfirmSchema } from '@/features/auth/schemas/password-reset';
import { z } from 'zod';
import { Button } from '@/app/components/ui/Button';
import { TextField } from '@/app/components/ui/TextField';

declare global {
  interface Window {
    onTurnstileReset?: (tokenValue: string) => void;
  }
}

export default function PasswordResetPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const emailFromQuery = searchParams.get('email');

  const [email, setEmail] = useState(emailFromQuery || '');
  const [newPassword, setNewPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

  useEffect(() => {
    if (!siteKey) return;
    window.onTurnstileReset = (tokenValue: string) => setTurnstileToken(tokenValue);
    return () => {
      if (window.onTurnstileReset) {
        delete window.onTurnstileReset;
      }
    };
  }, [siteKey]);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

    try {
      ResetRequestSchema.parse({ email, turnstileToken: turnstileToken || undefined });
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.issues.map((i) => i.message).join(' '));
      } else {
        setError('入力に誤りがあります');
      }
      return;
    }

    if (siteKey && !turnstileToken) {
      setError('ボット検証を完了してください');
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, turnstileToken: turnstileToken || undefined }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        setError(body?.error || '送信に失敗しました');
        return;
      }

      setMessage('パスワード再設定メールを送信しました。受信トレイをご確認ください。');
    } catch (err) {
      console.error(err);
      setError('送信に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

    try {
      ResetConfirmSchema.parse({ token: token || '', email, new_password: newPassword });
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.issues.map((i) => i.message).join(' '));
      } else {
        setError('入力に誤りがあります');
      }
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email, new_password: newPassword }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        setError(body?.error || '再設定に失敗しました');
        return;
      }

      setMessage('パスワードを更新しました。ログインしてください。');
    } catch (err) {
      console.error(err);
      setError('再設定に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const isConfirmMode = Boolean(token && emailFromQuery);

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="w-full max-w-md mx-auto px-6 font-brand">
        <h1 className="text-xl mb-6">
          {isConfirmMode ? 'パスワード再設定' : 'パスワード再設定の申請'}
        </h1>
        <form className="space-y-6" onSubmit={isConfirmMode ? handleConfirm : handleRequest}>
          <TextField
            id="email"
            label="EMAIL"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            type="email"
            disabled={Boolean(emailFromQuery)}
           size="md"/>

          {isConfirmMode ? (
            <TextField
              id="newPassword"
              label="NEW PASSWORD"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              type="password"
             size="md"/>
          ) : (
            siteKey ? (
              <div className="pt-2">
                <div className="cf-turnstile" data-sitekey={siteKey} data-callback="onTurnstileReset"></div>
              </div>
            ) : null
          )}

          <Button
            type="submit"
            className="w-full disabled:opacity-50"
            size="lg"
            disabled={loading}
          >
            {isConfirmMode ? 'パスワードを更新' : '再設定メールを送信'}
          </Button>
        </form>
        {error ? <p className="text-sm text-red-600 mt-4">{error}</p> : null}
        {message ? <p className="text-sm text-green-600 mt-4">{message}</p> : null}
      </div>
    </main>
  );
}
