import React, { useRef, useState } from "react";
import { useLogin } from "./LoginContext";
import { LoginRequestSchema } from '@/features/auth/schemas/login';
import { RegisterRequestSchema } from '@/features/auth/schemas/register';
import { z } from 'zod';

declare global {
  interface Window {
    onTurnstileSuccess?: (token: string) => void;
  }
}

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ open, onClose }) => {
  const { login, loginWithGoogle } = useLogin();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailRef.current?.value || "";
    const password = passwordRef.current?.value || "";

    try {
      LoginRequestSchema.parse({ email, password });
      setLoginError(null);
    } catch (err) {
      if (err instanceof z.ZodError) {
        setLoginError(err.issues.map((i) => i.message).join(' '));
      } else {
        setLoginError('入力に誤りがあります');
      }
      return;
    }

    try {
      const res = await login(email, password);
      if (res.success) {
        onClose();
      } else {
        setLoginError(res.error || 'ログインに失敗しました');
      }
    } catch (err) {
      console.error('Unexpected login error', err);
      setLoginError('ログインに失敗しました');
    }
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    (async () => {
      setRegisterError(null);
      const name = nameRef.current?.value || "";
      const email = emailRef.current?.value || "";
      const password = passwordRef.current?.value || "";

      // validate using RegisterRequestSchema
      try {
        RegisterRequestSchema.parse({ email, password, display_name: name });
      } catch (err) {
        if (err instanceof z.ZodError) {
          setRegisterError(err.issues.map((i) => i.message).join(' '));
        } else {
          setRegisterError('入力に誤りがあります');
        }
        return;
      }

      try {
        if (siteKey && !turnstileToken) {
          setRegisterError('ボット検証を完了してください');
          return;
        }

        setRegisterLoading(true);
        setRegisterSuccess(null);

        // Use server API so we can surface HTTP status codes (eg. 409)
        const payload = {
          email,
          password,
          display_name: name,
          emailRedirectTo: `${window.location.origin}/auth/verified`,
          turnstileToken: turnstileToken || undefined,
        };

        const resp = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        let respBody: unknown = null;
        try {
          respBody = await resp.json();
        } catch {
          // ignore parse errors
        }

        if (resp.status === 409) {
          const message =
            typeof respBody === 'object' && respBody && 'error' in respBody && typeof (respBody as { error?: unknown }).error === 'string'
              ? (respBody as { error: string }).error
              : null;
          setRegisterError(message || 'このメールアドレスは既に登録されています');
          return;
        }

        if (!resp.ok) {
          const message =
            typeof respBody === 'object' && respBody && 'error' in respBody && typeof (respBody as { error?: unknown }).error === 'string'
              ? (respBody as { error: string }).error
              : null;
          setRegisterError(message || '登録に失敗しました');
          return;
        }

        // 成功時（確認メールが送信されたなど）
        const successMessage =
          typeof respBody === 'object' && respBody && 'message' in respBody && typeof (respBody as { message?: unknown }).message === 'string'
            ? (respBody as { message: string }).message
            : null;
        setRegisterSuccess(successMessage || '登録が完了しました。確認メールを送信しました。メールを確認してください。');
      } catch (err) {
        console.error('Register request failed', err);
        setRegisterError('ネットワークエラーが発生しました');
      } finally {
        setRegisterLoading(false);
      }
    })();
  };

  React.useEffect(() => {
    if (!siteKey) return;
    window.onTurnstileSuccess = (token: string) => setTurnstileToken(token);
    return () => {
      if (window.onTurnstileSuccess) {
        delete window.onTurnstileSuccess;
      }
    };
  }, [siteKey]);

  if (!open) return null;

  return (
    <div className="w-full max-w-md mx-auto px-6 font-brand">
      <div className="mb-8">
        <div className="flex border border-black">
          <button
            className={`flex-1 py-3 text-sm tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap ${tab === 'login' ? 'bg-black text-white' : 'bg-white text-black hover:bg-black/5'}`}
            onClick={() => setTab('login')}
          >ログイン</button>
          <button
            className={`flex-1 py-3 text-sm tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap ${tab === 'register' ? 'bg-black text-white' : 'bg-white text-black hover:bg-black/5'}`}
            onClick={() => setTab('register')}
          >新規登録</button>
        </div>
      </div>
      {tab === 'login' ? (
        <form className="space-y-6 mb-8" onSubmit={handleLogin}>
          <div>
            <label htmlFor="email" className="block text-sm tracking-widest mb-2">EMAIL</label>
            <input id="email" ref={emailRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="email" />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm tracking-widest mb-2">PASSWORD</label>
            <input id="password" ref={passwordRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="password" />
          </div>
          <button type="submit" className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50">ログイン</button>
          {loginError ? <p className="text-sm text-red-600 mt-2">{loginError}</p> : null}
        </form>
      ) : (
        <form className="space-y-6 mb-8" onSubmit={handleRegister}>
          <div>
            <label htmlFor="name" className="block text-sm tracking-widest mb-2">NAME</label>
            <input id="name" ref={nameRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="text" />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm tracking-widest mb-2">EMAIL</label>
            <input id="email" ref={emailRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="email" />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm tracking-widest mb-2">PASSWORD</label>
            <input id="password" ref={passwordRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="password" />
          </div>
          <button type="submit" className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50">新規登録</button>
          {siteKey ? (
            <div className="pt-2">
              <div className="cf-turnstile" data-sitekey={siteKey} data-callback="onTurnstileSuccess"></div>
            </div>
          ) : null}
          {registerError ? <p className="text-sm text-red-600 mt-2">{registerError}</p> : null}
          {registerSuccess ? <p className="text-sm text-green-600 mt-2">{registerSuccess}</p> : null}
          {registerLoading ? <p className="text-sm text-gray-500 mt-2">登録中...</p> : null}
        </form>
      )}
      <div className="relative mb-8">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-black/20"></div></div>
        <div className="relative flex justify-center text-sm"><span className="px-4 bg-white text-[#474747]">OR</span></div>
      </div>
      <button
        type="button"
        onClick={() => {
          void loginWithGoogle({ next: '/auth/verified' });
        }}
        className="w-full py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap flex items-center justify-center gap-3"
      >
        <i className="ri-google-fill text-lg"></i>Googleで登録 / ログイン
      </button>
      {tab === 'login' ? (
        <div className="mt-6 text-center">
          <a href="/auth/password-reset" className="text-sm text-[#474747] hover:text-black transition-colors duration-300">パスワードをお忘れですか？</a>
        </div>
      ) : null}
    </div>
  );
};

export default LoginModal;
