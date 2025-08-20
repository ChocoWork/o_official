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
  const [tab, setTab] = useState<'login' | 'register'>('login');
  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailRef.current?.value || "";
    const password = passwordRef.current?.value || "";
    login(email, password);
    onClose();
  };

  // モーダル外クリックで閉じる
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/10 backdrop-blur-sm" onClick={handleOverlayClick}>
      <div className="relative w-full max-w-md" onClick={e => e.stopPropagation()}>
        {/* タブをモーダル本体の上部に配置し、ずれないように修正 */}
        <div className="flex w-full rounded-t-2xl overflow-hidden shadow-md border border-b-0 border-gray-300 bg-white" style={{marginBottom: '-1px'}}>
          <button
            className={`flex-1 py-3 text-center text-base font-medium transition relative bg-white ${tab === 'register' ? 'after:absolute after:left-0 after:right-0 after:bottom-0 after:h-[3px] after:bg-black' : 'after:content-[none]'}`}
            onClick={() => setTab('register')}
            style={{ borderTopLeftRadius: '1rem' }}
          >新規作成</button>
          <button
            className={`flex-1 py-3 text-center text-base font-medium transition relative bg-white ${tab === 'login' ? 'after:absolute after:left-0 after:right-0 after:bottom-0 after:h-[3px] after:bg-black' : 'after:content-[none]'}`}
            onClick={() => setTab('login')}
            style={{ borderTopRightRadius: '1rem' }}
          >ログイン</button>
        </div>
        <div className="bg-white rounded-b-2xl shadow-2xl border border-t-0 border-gray-300 pt-8 pb-8 px-8 animate-fadeIn relative">
          {tab === 'login' ? (
            <>
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label htmlFor="email" className="block text-sm font-medium mb-1">Email address</label>
                  <input ref={emailRef} type="email" id="email" className="w-full border border-gray-400 rounded px-3 py-2 bg-white text-black" placeholder="" required />
                </div>
                <div>
                  <label htmlFor="password" className="block text-sm font-medium mb-1">Password</label>
                  <input ref={passwordRef} type="password" id="password" className="w-full border border-gray-400 rounded px-3 py-2 bg-white text-black" placeholder="" required />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <label className="flex items-center">
                    <input type="checkbox" className="mr-1" />
                    Remember me
                  </label>
                  <a href="#" className="text-gray-700 hover:underline">Forgot password?</a>
                </div>
                <button type="submit" className="w-full bg-black text-white rounded py-2 font-bold mt-2 hover:bg-gray-800 transition">Sign in</button>
              </form>
              <div className="flex items-center my-6">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="mx-2 text-gray-400 text-xs">Or continue with</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
              <div className="flex gap-4 mb-4">
                <button className="flex-1 flex items-center justify-center border border-gray-400 rounded px-4 py-2 font-medium hover:bg-gray-100 gap-2 bg-white text-black">
                  <span className="text-lg"> <svg width='20' height='20' viewBox='0 0 48 48'><g><path fill="#4285F4" d="M44.5 20H24v8.5h11.7C34.7 33.1 30.1 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c2.6 0 5 .8 7 2.3l6.4-6.4C33.5 5.5 28.9 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.2-4z"/><path fill="#34A853" d="M6.3 14.7l7 5.1C15.5 16.1 19.4 13 24 13c2.6 0 5 .8 7 2.3l6.4-6.4C33.5 5.5 28.9 4 24 4c-7.7 0-14.2 4.4-17.7 10.7z"/><path fill="#FBBC05" d="M24 44c6.1 0 11.2-2 14.9-5.4l-7-5.7C29.7 34.7 27 36 24 36c-6.1 0-11.2-2-14.9-5.4l7-5.7C18.3 31.3 21 33 24 33z"/><path fill="#EA4335" d="M44.5 20H24v8.5h11.7C34.7 33.1 30.1 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c2.6 0 5 .8 7 2.3l6.4-6.4C33.5 5.5 28.9 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.2-4z"/></g></svg></span>
                  Google
                </button>
                <button className="flex-1 flex items-center justify-center border border-gray-400 rounded px-4 py-2 font-medium hover:bg-gray-100 gap-2 bg-white text-black">
                  <span className="text-lg"><svg width='20' height='20' viewBox='0 0 24 24'><path fill="#24292F" d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.867 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.461-1.11-1.461-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.529 2.341 1.088 2.91.832.091-.647.35-1.088.636-1.339-2.221-.253-4.555-1.111-4.555-4.945 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.272.098-2.65 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.748-1.025 2.748-1.025.546 1.378.202 2.397.1 2.65.64.699 1.028 1.592 1.028 2.683 0 3.842-2.337 4.688-4.566 4.936.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.749 0 .267.18.577.688.479C19.135 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg></span>
                  GitHub
                </button>
              </div>
              <div className="text-center text-xs text-gray-500 mt-6">
                Not a member? <a href="#" className="text-black hover:underline font-medium">Start a 14 day free trial</a>
              </div>
            </>
          ) : (
            <>
              <form className="space-y-4" onSubmit={e => { e.preventDefault(); /* 新規作成の処理 */ }}>
                <div>
                  <label htmlFor="register-email" className="block text-sm font-medium mb-1">Email address</label>
                  <input type="email" id="register-email" className="w-full border border-gray-400 rounded px-3 py-2 bg-white text-black" required />
                </div>
                <div>
                  <label htmlFor="register-password" className="block text-sm font-medium mb-1">Password</label>
                  <input type="password" id="register-password" className="w-full border border-gray-400 rounded px-3 py-2 bg-white text-black" required />
                </div>
                <div>
                  <label htmlFor="register-password2" className="block text-sm font-medium mb-1">Confirm password</label>
                  <input type="password" id="register-password2" className="w-full border border-gray-400 rounded px-3 py-2 bg-white text-black" required />
                </div>
                <button type="submit" className="w-full bg-black text-white rounded py-2 font-bold mt-2 hover:bg-gray-800 transition">Create account</button>
              </form>
              <div className="flex items-center my-6">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="mx-2 text-gray-400 text-xs">Or continue with</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
              <div className="flex gap-4 mb-4">
                <button className="flex-1 flex items-center justify-center border border-gray-400 rounded px-4 py-2 font-medium hover:bg-gray-100 gap-2 bg-white text-black">
                  <span className="text-lg"> <svg width='20' height='20' viewBox='0 0 48 48'><g><path fill="#4285F4" d="M44.5 20H24v8.5h11.7C34.7 33.1 30.1 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c2.6 0 5 .8 7 2.3l6.4-6.4C33.5 5.5 28.9 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.2-4z"/><path fill="#34A853" d="M6.3 14.7l7 5.1C15.5 16.1 19.4 13 24 13c2.6 0 5 .8 7 2.3l6.4-6.4C33.5 5.5 28.9 4 24 4c-7.7 0-14.2 4.4-17.7 10.7z"/><path fill="#FBBC05" d="M24 44c6.1 0 11.2-2 14.9-5.4l-7-5.7C29.7 34.7 27 36 24 36c-6.1 0-11.2-2-14.9-5.4l7-5.7C18.3 31.3 21 33 24 33z"/><path fill="#EA4335" d="M44.5 20H24v8.5h11.7C34.7 33.1 30.1 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c2.6 0 5 .8 7 2.3l6.4-6.4C33.5 5.5 28.9 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.2-4z"/></g></svg></span>
                  Google
                </button>
                <button className="flex-1 flex items-center justify-center border border-gray-400 rounded px-4 py-2 font-medium hover:bg-gray-100 gap-2 bg-white text-black">
                  <span className="text-lg"><svg width='20' height='20' viewBox='0 0 24 24'><path fill="#24292F" d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.867 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.461-1.11-1.461-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.529 2.341 1.088 2.91.832.091-.647.35-1.088.636-1.339-2.221-.253-4.555-1.111-4.555-4.945 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.272.098-2.65 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.748-1.025 2.748-1.025.546 1.378.202 2.397.1 2.65.64.699 1.028 1.592 1.028 2.683 0 3.842-2.337 4.688-4.566 4.936.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.749 0 .267.18.577.688.479C19.135 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg></span>
                  GitHub
                </button>
              </div>
              <div className="text-center text-xs text-gray-500 mt-6">
                すでにアカウントをお持ちですか？ <a href="#" className="text-black hover:underline font-medium" onClick={() => setTab('login')}>ログイン</a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
