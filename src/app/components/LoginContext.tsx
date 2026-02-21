'use client';

import React, { createContext, useContext, useState, ReactNode } from "react";
import { supabase } from '@/lib/supabase/client';
import type { Session } from '@supabase/supabase-js';

interface LoginContextType {
  isLoggedIn: boolean;
  isAdmin: boolean;
  sendOtp: (email: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  verifyOtp: (email: string, code: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  loginWithGoogle: (params?: { next?: string }) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

const LoginContext = createContext<LoginContextType | undefined>(undefined);

export const useLogin = () => {
  const context = useContext(LoginContext);
  if (!context) throw new Error("useLogin must be used within a LoginProvider");
  return context;
};

export const LoginProvider = ({ children }: { children: ReactNode }) => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const sendOtp = async (email: string, turnstileToken?: string) => {
    try {
      const { IdentifyRequestSchema } = await import('@/features/auth/schemas/identify');
      const parsed = IdentifyRequestSchema.safeParse({ email, turnstileToken });
      if (!parsed.success) {
        return { success: false, error: parsed.error.issues.map((i) => i.message).join(' ') };
      }

      const resp = await fetch('/api/auth/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, turnstileToken, redirect_to: '/auth/verified' }),
      });

      const body: unknown = await resp.json().catch(() => null);
      if (!resp.ok) {
        const message =
          typeof body === 'object' && body && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'メール送信に失敗しました';
        return { success: false, error: message };
      }

      const message =
        typeof body === 'object' && body && 'message' in body && typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message
          : 'メールを送信しました。受信したリンクをご確認ください。';

      return { success: true, message };
    } catch (e) {
      console.error('OTP send error', e);
      return { success: false, error: '内部エラーが発生しました' };
    }
  };

  const verifyOtp = async (email: string, code: string) => {
    try {
      const { OtpVerifyRequestSchema } = await import('@/features/auth/schemas/otp');
      const parsed = OtpVerifyRequestSchema.safeParse({ email, code });
      if (!parsed.success) {
        return { success: false, error: parsed.error.issues.map((i) => i.message).join(' ') };
      }

      const resp = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });

      const body: unknown = await resp.json().catch(() => null);
      if (!resp.ok) {
        const message =
          typeof body === 'object' && body && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : '認証に失敗しました';
        return { success: false, error: message };
      }

      const message =
        typeof body === 'object' && body && 'message' in body && typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message
          : '認証に成功しました。';

      setIsLoggedIn(true);
      return { success: true, message };
    } catch (e) {
      console.error('OTP verify error', e);
      return { success: false, error: '内部エラーが発生しました' };
    }
  };

  const loginWithGoogle = async (params?: { next?: string }) => {
    try {
      const next = params?.next && params.next.startsWith('/') ? params.next : '/auth/verified';
      const url = `/api/auth/oauth/start?provider=google&redirect_to=${encodeURIComponent(next)}`;
      window.location.assign(url);
      return { success: true };
    } catch (e) {
      console.error('OAuth login error', e);
      return { success: false, error: 'OAuthログインに失敗しました' };
    }
  };

  const logout = () => {
    (async () => {
      try {
        await supabase.auth.signOut();
      } catch (e) {
        console.error('Sign out error', e);
      } finally {
        setIsLoggedIn(false);
        setIsAdmin(false);
      }
    })();
  };

  // 初期セッション確認と状態変化の購読
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const session = data.session;
        if (mounted && session?.user) {
          setIsLoggedIn(true);
          setIsAdmin(session.user.email === 'aaa@gmail.com');
        }
      } catch (e) {
        console.error('Error fetching initial session', e);
      }
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session: Session | null) => {
      const user = session?.user;
      setIsLoggedIn(!!user);
      setIsAdmin(user?.email === 'aaa@gmail.com');
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <LoginContext.Provider value={{ isLoggedIn, isAdmin, sendOtp, verifyOtp, loginWithGoogle, logout }}>
      {children}
    </LoginContext.Provider>
  );
};
