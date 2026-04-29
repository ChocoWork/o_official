'use client';

import React, { createContext, useContext, useState, ReactNode } from "react";
import { supabase } from '@/lib/supabase/client';
import { navigateBrowser } from '@/lib/browser-location';

type UserRole = 'admin' | 'supporter' | 'user';

const isUserRole = (role: unknown): role is UserRole => {
  return role === 'admin' || role === 'supporter' || role === 'user';
};

interface LoginContextType {
  isLoggedIn: boolean;
  isAdmin: boolean;
  userRole: UserRole;
  isMfaVerified: boolean;
  isAuthResolved: boolean;
  sendOtp: (email: string, turnstileToken?: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  verifyOtp: (email: string, code: string) => Promise<{ success: boolean; error?: string; message?: string }>;
  loginWithGoogle: (params?: { next?: string }) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<{ success: boolean; error?: string }>;
}

type OtpVerifySuccessBody = {
  message?: string;
};

type AuthStateResponseBody = {
  authenticated?: boolean;
  user?: {
    role?: unknown;
    mfaVerified?: boolean;
  };
};

const LoginContext = createContext<LoginContextType | undefined>(undefined);

export const useLogin = () => {
  const context = useContext(LoginContext);
  if (!context) throw new Error("useLogin must be used within a LoginProvider");
  return context;
};

export const LoginProvider = ({ children }: { children: ReactNode }) => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userRole, setUserRole] = useState<UserRole>('user');
  const [isMfaVerified, setIsMfaVerified] = useState(false);
  const [isAuthResolved, setIsAuthResolved] = useState(false);

  const getCsrfTokenFromCookie = () => {
    if (typeof document === 'undefined') return undefined;

    const targetCookie = document.cookie
      .split('; ')
      .find((cookie) => cookie.startsWith('sb-csrf-token='));

    if (!targetCookie) return undefined;
    return decodeURIComponent(targetCookie.split('=').slice(1).join('='));
  };

  const applyAuthState = React.useCallback((authenticated: boolean, role?: unknown, mfaVerified?: boolean) => {
    const resolvedRole = authenticated && isUserRole(role) ? role : 'user';
    setIsLoggedIn(authenticated);
    setUserRole(resolvedRole);
    setIsAdmin(authenticated && resolvedRole === 'admin');
    setIsMfaVerified(authenticated && mfaVerified === true);
    setIsAuthResolved(true);
  }, []);

  const syncAuthState = React.useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
      });

      const body: unknown = await response.json().catch(() => null);
      const authState = typeof body === 'object' && body ? (body as AuthStateResponseBody) : null;
      const authenticated = response.ok && authState?.authenticated === true;
      applyAuthState(authenticated, authState?.user?.role, authState?.user?.mfaVerified);
    } catch (error) {
      console.error('Failed to sync auth state', error);
      applyAuthState(false);
    }
  }, [applyAuthState]);

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

      const successBody = typeof body === 'object' && body ? (body as OtpVerifySuccessBody) : null;
      const message =
        typeof successBody?.message === 'string'
          ? successBody.message
          : '認証に成功しました。';

      await syncAuthState();
      return { success: true, message };
    } catch (e) {
      console.error('OTP verify error', e);
      return { success: false, error: '内部エラーが発生しました' };
    }
  };

  const loginWithGoogle = async (params?: { next?: string }) => {
    try {
      const next = params?.next && params.next.startsWith('/') ? params.next : '/auth/verified';

      navigateBrowser(`/api/auth/oauth/start?provider=google&redirect_to=${encodeURIComponent(next)}`);
      return { success: true };
    } catch (e) {
      console.error('OAuth login error', e);
      return { success: false, error: 'OAuthログインに失敗しました' };
    }
  };

  const logout = async () => {
    try {
      const csrfToken = getCsrfTokenFromCookie();
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: csrfToken
          ? {
              'x-csrf-token': csrfToken,
            }
          : undefined,
      });
      await supabase.auth.signOut();
      return { success: true };
    } catch (e) {
      console.error('Sign out error', e);
      return { success: false, error: 'ログアウトに失敗しました' };
    } finally {
      setIsLoggedIn(false);
      setIsAdmin(false);
      setUserRole('user');
      setIsMfaVerified(false);
      setIsAuthResolved(true);
    }
  };

  // 初期セッション確認と状態変化の購読
  React.useEffect(() => {
    void syncAuthState();
  }, [syncAuthState]);

  return (
    <LoginContext.Provider
      value={{
        isLoggedIn,
        isAdmin,
        userRole,
        isMfaVerified,
        isAuthResolved,
        sendOtp,
        verifyOtp,
        loginWithGoogle,
        logout,
      }}
    >
      {children}
    </LoginContext.Provider>
  );
};
