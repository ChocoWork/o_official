"use client";

import React, { useEffect, useState } from 'react';
import Script from 'next/script';
import { ResetRequestSchema, ResetSessionConfirmSchema } from '@/features/auth/schemas/password-reset';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';

declare global {
  interface Window {
    onTurnstileReset?: (tokenValue: string) => void;
  }
}

export default function PasswordResetPage() {
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isConfirmMode, setIsConfirmMode] = useState(false);
  const [isResolvingSession, setIsResolvingSession] = useState(true);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

  useEffect(() => {
    let active = true;

    const resolveResetSession = async () => {
      try {
        const response = await fetch('/api/auth/password-reset/session', {
          method: 'GET',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          return;
        }

        const body = await response.json().catch(() => null);
        if (!active || !body) {
          return;
        }

        if (body.ready) {
          setIsConfirmMode(true);
          setEmail(typeof body.email === 'string' ? body.email : '');
        } else {
          setIsConfirmMode(false);
        }
      } catch {
        if (active) {
          setIsConfirmMode(false);
        }
      } finally {
        if (active) {
          setIsResolvingSession(false);
        }
      }
    };

    void resolveResetSession();

    return () => {
      active = false;
    };
  }, []);

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
      ResetSessionConfirmSchema.parse({ new_password: newPassword });
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
        body: JSON.stringify({ new_password: newPassword }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        setError(body?.error || '再設定に失敗しました');
        return;
      }

      setMessage('パスワードを更新しました。ログインしてください。');
      setIsConfirmMode(false);
      setEmail('');
      setNewPassword('');
    } catch (err) {
      console.error(err);
      setError('再設定に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      {siteKey ? (
        <Script
          id="turnstile-reset-script"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
        />
      ) : null}
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
            disabled={isConfirmMode || isResolvingSession}
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
            disabled={loading || isResolvingSession}
          >
            {isResolvingSession ? '確認中...' : isConfirmMode ? 'パスワードを更新' : '再設定メールを送信'}
          </Button>
        </form>
        {error ? <p className="text-sm text-red-600 mt-4">{error}</p> : null}
        {message ? <p className="text-sm text-green-600 mt-4">{message}</p> : null}
      </div>
    </div>
  );
}
