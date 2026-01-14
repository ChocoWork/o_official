import React, { useRef, useState } from "react";
import { useLogin } from "./LoginContext";

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
    // 新規登録処理（必要に応じて実装）
    onClose();
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
