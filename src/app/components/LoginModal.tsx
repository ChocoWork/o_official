import React, { useRef, useState } from "react";
import { useLogin } from "./LoginContext";
import { supabase } from '@/lib/supabase/client';

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ open, onClose }) => {
  const { login } = useLogin();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerSuccess, setRegisterSuccess] = useState<string | null>(null);
  if (!open) return null;

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailRef.current?.value || "";
    const password = passwordRef.current?.value || "";
    login(email, password);
    onClose();
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    (async () => {
      setRegisterError(null);
      const name = nameRef.current?.value || "";
      const email = emailRef.current?.value || "";
      const password = passwordRef.current?.value || "";

      if (!email || !password) {
        setRegisterError('メールとパスワードを入力してください');
        return;
      }
      if (password.length < 8) {
        setRegisterError('パスワードは8文字以上にしてください');
        return;
      }

      try {
        setRegisterLoading(true);
        setRegisterSuccess(null);

        // 一時的に資格情報を sessionStorage に保存しておく（検証後の自動ログイン用）
        try {
          sessionStorage.setItem(
            'pending_signup',
            JSON.stringify({ email, password, ts: Date.now() })
          );
        } catch (e) {
          // sessionStorage が使えない場合はスキップ
        }

        // サーバー側例に合わせて、単一オブジェクトで options をネストして渡す
        const signUpPayload: Parameters<typeof supabase.auth.signUp>[0] = {
          email,
          password,
          options: {
            data: { display_name: name },
            // サイトのベースURLに合わせた確認後リダイレクト先
            // emailRedirectTo: `${window.location.origin}/auth/verified`,
            emailRedirectTo: `http://localhost:3000/auth/verified`,
          },
        };

        // 確認のため実行時オブジェクトをログ出力（検証後は削除可）
        // eslint-disable-next-line no-console
        console.log('signUp payload', signUpPayload);

        const { data, error } = await supabase.auth.signUp(signUpPayload);

        if (error) {
          console.error('Supabase signUp error', error);
          setRegisterError(error.message || '登録に失敗しました');
          return;
        }

        // data.session が返れば即時ログインされる環境（メール確認不要）
        if ((data as any)?.session) {
          await login(email, password);
          onClose();
          return;
        }

        // 多くの設定では確認メールが送信され、即時ログインされない
        setRegisterSuccess('登録が完了しました。確認メールを送信しました。メールを確認してください。');
      } catch (err) {
        console.error('Register request failed', err);
        setRegisterError('ネットワークエラーが発生しました');
      } finally {
        setRegisterLoading(false);
      }
    })();
  };

  // モーダル外クリックで閉じる
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="w-full max-w-md mx-auto px-6">
      <div className="mb-8">
        <div className="flex border border-black">
          <button
            className={`flex-1 py-3 text-sm tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap ${tab === 'login' ? 'bg-black text-white' : 'bg-white text-black hover:bg-black/5'}`}
            style={{ fontFamily: 'acumin-pro, sans-serif' }}
            onClick={() => setTab('login')}
          >ログイン</button>
          <button
            className={`flex-1 py-3 text-sm tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap ${tab === 'register' ? 'bg-black text-white' : 'bg-white text-black hover:bg-black/5'}`}
            style={{ fontFamily: 'acumin-pro, sans-serif' }}
            onClick={() => setTab('register')}
          >新規登録</button>
        </div>
      </div>
      {tab === 'login' ? (
        <form className="space-y-6 mb-8" onSubmit={handleLogin}>
          <div>
            <label htmlFor="email" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>EMAIL</label>
            <input id="email" ref={emailRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="email" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>PASSWORD</label>
            <input id="password" ref={passwordRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="password" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
          </div>
          <button type="submit" className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ログイン</button>
        </form>
      ) : (
        <form className="space-y-6 mb-8" onSubmit={handleRegister}>
          <div>
            <label htmlFor="name" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>NAME</label>
            <input id="name" ref={nameRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="text" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>EMAIL</label>
            <input id="email" ref={emailRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="email" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>PASSWORD</label>
            <input id="password" ref={passwordRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="password" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
          </div>
          <button type="submit" className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50" style={{ fontFamily: 'acumin-pro, sans-serif' }}>新規登録</button>
          {registerError ? <p className="text-sm text-red-600 mt-2">{registerError}</p> : null}
          {registerSuccess ? <p className="text-sm text-green-600 mt-2">{registerSuccess}</p> : null}
          {registerLoading ? <p className="text-sm text-gray-500 mt-2">登録中...</p> : null}
        </form>
      )}
      <div className="relative mb-8">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-black/20"></div></div>
        <div className="relative flex justify-center text-sm"><span className="px-4 bg-white text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>OR</span></div>
      </div>
      <button className="w-full py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap flex items-center justify-center gap-3" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
        <i className="ri-google-fill text-lg"></i>Googleでログイン
      </button>
      {tab === 'login' ? (
        <div className="mt-6 text-center">
          <a href="#" className="text-sm text-[#474747] hover:text-black transition-colors duration-300" style={{ fontFamily: 'acumin-pro, sans-serif' }}>パスワードをお忘れですか？</a>
        </div>
      ) : null}
    </div>
  );
};

export default LoginModal;
