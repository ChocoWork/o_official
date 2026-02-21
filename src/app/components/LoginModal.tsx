import React, { useRef, useState } from "react";
import { useLogin } from "./LoginContext";
import { z } from 'zod';
import { IdentifyRequestSchema } from '@/features/auth/schemas/identify';
import { useRouter } from 'next/navigation';

declare global {
  interface Window {
    onTurnstileSuccess?: (token: string) => void;
  }
}

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
}

const OTP_LENGTH = 8;
const EMPTY_OTP_DIGITS = Array.from({ length: OTP_LENGTH }, () => '');

const LoginModal: React.FC<LoginModalProps> = ({ open, onClose }) => {
  const { sendOtp, verifyOtp, loginWithGoogle } = useLogin();
  const router = useRouter();
  const emailRef = useRef<HTMLInputElement>(null);
  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [otpDigits, setOtpDigits] = useState<string[]>(EMPTY_OTP_DIGITS);
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const [otpSentTime, setOtpSentTime] = useState<Date | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';
  const otpCode = otpDigits.join('');

  const focusOtpInput = (index: number) => {
    const input = otpInputRefs.current[index];
    if (input) {
      input.focus();
      input.select();
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    const numbersOnly = value.replace(/\D/g, '');

    if (!numbersOnly) {
      setOtpDigits((prev) => {
        const next = [...prev];
        next[index] = '';
        return next;
      });
      return;
    }

    setOtpDigits((prev) => {
      const next = [...prev];
      let cursor = index;

      for (const digit of numbersOnly) {
        if (cursor >= OTP_LENGTH) break;
        next[cursor] = digit;
        cursor += 1;
      }

      return next;
    });

    const nextIndex = Math.min(index + numbersOnly.length, OTP_LENGTH - 1);
    focusOtpInput(nextIndex);
  };

  const handleOtpKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      setOtpDigits((prev) => {
        const next = [...prev];
        if (next[index]) {
          next[index] = '';
          return next;
        }

        if (index > 0) {
          next[index - 1] = '';
          setTimeout(() => focusOtpInput(index - 1), 0);
        }

        return next;
      });
      return;
    }

    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusOtpInput(index - 1);
    }

    if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
      event.preventDefault();
      focusOtpInput(index + 1);
    }
  };

  const handleOtpPaste = (index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '');
    if (!pasted) return;

    setOtpDigits((prev) => {
      const next = [...prev];
      let cursor = index;

      for (const digit of pasted) {
        if (cursor >= OTP_LENGTH) break;
        next[cursor] = digit;
        cursor += 1;
      }

      return next;
    });

    const nextIndex = Math.min(index + pasted.length, OTP_LENGTH - 1);
    focusOtpInput(nextIndex);
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailRef.current?.value || "";

    try {
      IdentifyRequestSchema.parse({ email, turnstileToken: turnstileToken || undefined });
      setError(null);
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
    setSuccess(null);
    try {
      const res = await sendOtp(email, turnstileToken || undefined);
      if (!res.success) {
        setError(res.error || 'メール送信に失敗しました');
      } else {
        setOtpSent(true);
        setOtpSentTime(new Date());
        setTimeRemaining(60);
        setOtpDigits([...EMPTY_OTP_DIGITS]);
        setTimeout(() => focusOtpInput(0), 0);
        setSuccess(res.message || '認証コードを送信しました。');
      }
    } catch (err) {
      console.error('Unexpected OTP send error', err);
      setError('メール送信に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailRef.current?.value || '';
    const code = otpCode;

    if (code.length !== OTP_LENGTH) {
      setError('認証コードは8桁で入力してください');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await verifyOtp(email, code);
      if (!res.success) {
        setError(res.error || '認証コードの確認に失敗しました');
        return;
      }
      setSuccess(res.message || '認証に成功しました。');
      onClose();
      router.replace('/');
    } catch (err) {
      console.error('Unexpected OTP verify error', err);
      setError('認証コードの確認に失敗しました');
    } finally {
      setLoading(false);
    }
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

  React.useEffect(() => {
    if (!otpSentTime) return;

    const interval = setInterval(() => {
      const now = new Date();
      const elapsed = (now.getTime() - otpSentTime.getTime()) / 1000;
      const remaining = Math.max(0, 60 - Math.floor(elapsed));
      setTimeRemaining(remaining);

      if (remaining === 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [otpSentTime]);

  if (!open) return null;

  return (
    <div className="w-full max-w-md mx-auto px-6 font-brand">
      <div className="mb-8 text-center">
        <h1 className="text-lg tracking-widest mb-2">サインイン</h1>
      </div>
      <button
        type="button"
        onClick={() => {
          void loginWithGoogle({ next: '/' });
        }}
        className="w-full py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap flex items-center justify-center gap-3 mb-8"
      >
        <i className="ri-google-fill text-lg"></i>Googleでサインイン
      </button>
      <div className="relative mb-8">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-black/20"></div></div>
        <div className="relative flex justify-center text-sm"><span className="px-4 bg-white text-[#474747]">OR</span></div>
      </div>
      <form className="space-y-6 mb-8" onSubmit={otpSent ? handleVerifyOtp : handleSendOtp}>
        <div>
          <label htmlFor="email" className="block text-sm tracking-widest mb-2">EMAIL</label>
          <input id="email" ref={emailRef} required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="email" disabled={otpSent} />
        </div>
        {otpSent ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="otp" className="block text-sm tracking-widest">認証コード</label>
              {timeRemaining > 0 ? (
                <span className="text-xs text-[#474747]">{timeRemaining}秒</span>
              ) : (
                <button
                  type="button"
                  className="text-xs underline text-[#474747] hover:text-black transition-colors"
                  onClick={async () => {
                    const email = emailRef.current?.value || '';
                    setLoading(true);
                    setError(null);
                    try {
                      const res = await sendOtp(email, turnstileToken || undefined);
                      if (!res.success) {
                        setError(res.error || 'メール送信に失敗しました');
                      } else {
                        setOtpSentTime(new Date());
                        setTimeRemaining(60);
                        setOtpDigits([...EMPTY_OTP_DIGITS]);
                        setTimeout(() => focusOtpInput(0), 0);
                        setSuccess(res.message || '認証コードを再送信しました。');
                      }
                    } catch (err) {
                      console.error('Unexpected OTP resend error', err);
                      setError('メール送信に失敗しました');
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  再送信
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2" id="otp">
              {Array.from({ length: OTP_LENGTH }).map((_, index) => (
                <input
                  key={index}
                  ref={(el) => {
                    otpInputRefs.current[index] = el;
                  }}
                  value={otpDigits[index]}
                  onChange={(event) => handleOtpChange(index, event.target.value)}
                  onKeyDown={(event) => handleOtpKeyDown(index, event)}
                  onPaste={(event) => handleOtpPaste(index, event)}
                  className="w-10 h-11 border border-black/20 text-center text-lg outline-none transition-colors duration-200 focus:border-black"
                  type="text"
                  inputMode="numeric"
                  autoComplete={index === 0 ? 'one-time-code' : 'off'}
                  maxLength={1}
                  aria-label={`認証コード ${index + 1} 桁目`}
                />
              ))}
            </div>
          </div>
        ) : null}
        {siteKey ? (
          <div className="pt-2">
            <div className="cf-turnstile" data-sitekey={siteKey} data-callback="onTurnstileSuccess"></div>
          </div>
        ) : null}
        <button type="submit" className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50" disabled={loading || (otpSent && otpCode.length !== OTP_LENGTH)}>
          {loading ? '処理中...' : otpSent ? 'サインイン' : 'メールで認証コードを受け取る'}
        </button>
        {otpSent ? (
          <button
            type="button"
            className="w-full py-3 border border-black/20 text-sm tracking-widest hover:bg-black/5 transition-all duration-300"
            onClick={() => {
              setOtpSent(false);
              setOtpSentTime(null);
              setTimeRemaining(0);
              setError(null);
              setSuccess(null);
              setOtpDigits([...EMPTY_OTP_DIGITS]);
            }}
          >
            メールアドレスを変更
          </button>
        ) : null}
        {error ? <p className="text-sm text-red-600 mt-2">{error}</p> : null}
        {success ? <p className="text-sm text-green-600 mt-2">{success}</p> : null}
      </form>
      <div className="relative mb-16">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-black/20"></div></div>
      </div>
      <p className="max-w-[360px] mx-auto px-2 text-xs text-[#474747] text-center leading-6 mb-8 break-keep [text-wrap:pretty]">
        続行することで、
        <a href="/terms" className="underline hover:text-black transition-colors">利用規約</a>
        および
        <a href="/privacy" className="underline hover:text-black transition-colors">プライバシーポリシー</a>に<br />
        同意したものとみなされます。
      </p>
    </div>
  );
};

export default LoginModal;
