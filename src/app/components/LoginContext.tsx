'use client';

import React, { createContext, useContext, useState, ReactNode } from "react";
import { supabase } from '@/lib/supabase/client';

interface LoginContextType {
  isLoggedIn: boolean;
  isAdmin: boolean;
  login: (email?: string, password?: string) => Promise<{ success: boolean; error?: string }>;
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

  const login = async (email?: string, password?: string) => {
    try {
      // client-side validation before sending
      const { LoginRequestSchema } = await import('@/features/auth/schemas/login');
      try {
        LoginRequestSchema.parse({ email: email || '', password: password || '' });
      } catch (err) {
        if (err instanceof Error && (err as any).issues) {
          // ZodError
          const message = (err as any).issues.map((i: any) => i.message).join(' ');
          setIsLoggedIn(false);
          setIsAdmin(false);
          return { success: false, error: message };
        }
        return { success: false, error: '入力が無効です' };
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: email || '',
        password: password || '',
      });
      if (error) {
        console.error('Supabase signIn error', error);
        setIsLoggedIn(false);
        setIsAdmin(false);
        return { success: false, error: error.message || 'ログインに失敗しました' };
      }
      const userEmail = data.user?.email;
      setIsLoggedIn(true);
      setIsAdmin(userEmail === 'aaa@gmail.com');
      return { success: true };
    } catch (e) {
      console.error('Login error', e);
      setIsLoggedIn(false);
      setIsAdmin(false);
      return { success: false, error: '内部エラーが発生しました' };
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
        const session = (data as any)?.session;
        if (mounted && session?.user) {
          setIsLoggedIn(true);
          setIsAdmin(session.user.email === 'aaa@gmail.com');
        }
      } catch (e) {
        console.error('Error fetching initial session', e);
      }
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = (session as any)?.user;
      setIsLoggedIn(!!user);
      setIsAdmin(user?.email === 'aaa@gmail.com');
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <LoginContext.Provider value={{ isLoggedIn, isAdmin, login, logout }}>
      {children}
    </LoginContext.Provider>
  );
};
