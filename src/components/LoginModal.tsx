"use client";

import React, { useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { useLogin } from "@/contexts/LoginContext";
import { z } from "zod";
import { LoginRequestSchema } from "@/features/auth/schemas/login";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { TextField } from "@/components/ui/TextField/TextField";
import { useTurnstileWidget } from "@/hooks/useTurnstileWidget";

interface LoginModalProps {
  open: boolean;
  onClose?: () => void;
}

type AuthMeResponse = {
  authenticated?: boolean;
  user?: {
    role?: unknown;
  };
};

const isPrivilegedRole = (role: unknown): boolean =>
  role === "admin" || role === "supporter";

const OTP_LENGTH = 8;
const EMPTY_OTP_DIGITS = Array.from({ length: OTP_LENGTH }, () => "");

const formatOtpCountdown = (timeRemaining: number) => {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;
  return `${minutes}分 ${String(seconds).padStart(2, "0")}秒後に再送可能`;
};

const xsTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-xs)" };
const mdTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-md)" };
const lgTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-lg)" };

const LoginModal: React.FC<LoginModalProps> = ({ open, onClose }) => {
  const { login, verifyOtp, loginWithGoogle } = useLogin();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [otpDigits, setOtpDigits] = useState<string[]>(EMPTY_OTP_DIGITS);
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [otpSentTime, setOtpSentTime] = useState<Date | null>(null);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
  const otpCode = otpDigits.join("");
  const { containerRef: turnstileRef, renderWidget: renderTurnstile } =
    useTurnstileWidget(siteKey, setTurnstileToken);

  const resolvePostLoginPath = React.useCallback(async (): Promise<string> => {
    try {
      const response = await fetch("/api/auth/me", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });

      const body = (await response
        .json()
        .catch(() => null)) as AuthMeResponse | null;
      const authenticated = response.ok && body?.authenticated === true;
      if (!authenticated) {
        return "/login";
      }

      return isPrivilegedRole(body?.user?.role) ? "/auth/verified" : "/account";
    } catch {
      return "/account";
    }
  }, []);

  const focusOtpInput = (index: number) => {
    const input = otpInputRefs.current[index];
    if (input) {
      input.focus();
      input.select();
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    const numbersOnly = value.replace(/\D/g, "");

    if (!numbersOnly) {
      setOtpDigits((prev) => {
        const next = [...prev];
        next[index] = "";
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

  const handleOtpKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      setOtpDigits((prev) => {
        const next = [...prev];
        if (next[index]) {
          next[index] = "";
          return next;
        }

        if (index > 0) {
          next[index - 1] = "";
          setTimeout(() => focusOtpInput(index - 1), 0);
        }

        return next;
      });
      return;
    }

    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      focusOtpInput(index - 1);
    }

    if (event.key === "ArrowRight" && index < OTP_LENGTH - 1) {
      event.preventDefault();
      focusOtpInput(index + 1);
    }
  };

  const handleOtpPaste = (
    index: number,
    event: React.ClipboardEvent<HTMLInputElement>,
  ) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "");
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      LoginRequestSchema.parse({
        email,
        password,
        turnstileToken: turnstileToken || undefined,
      });
      setError(null);
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.issues.map((i) => i.message).join(" "));
      } else {
        setError("入力に誤りがあります");
      }
      return;
    }

    if (siteKey && !turnstileToken) {
      setError("ボット検証を完了してください");
      return;
    }

    setLoading(true);
    setSuccess(null);
    try {
      const res = await login(email, password, turnstileToken || undefined);
      if (!res.success) {
        setError(res.error || "ログインに失敗しました");
      } else {
        setOtpSent(true);
        setOtpSentTime(new Date());
        setTimeRemaining(60);
        setOtpDigits([...EMPTY_OTP_DIGITS]);
        setTimeout(() => focusOtpInput(0), 0);
        setSuccess(res.message || "認証コードを送信しました。");
      }
    } catch (err) {
      console.error("Unexpected login error", err);
      setError("ログインに失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otpCode;

    if (code.length !== OTP_LENGTH) {
      setError("認証コードは8桁で入力してください");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await verifyOtp(email, code);
      if (!res.success) {
        setError(res.error || "認証コードの確認に失敗しました");
        return;
      }
      setSuccess(res.message || "認証に成功しました。");
      onClose?.();
      const nextPath = await resolvePostLoginPath();
      router.replace(nextPath);
    } catch (err) {
      console.error("Unexpected OTP verify error", err);
      setError("認証コードの確認に失敗しました");
    } finally {
      setLoading(false);
    }
  };

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
    <div className="w-full max-w-md mx-auto px-6">
      {siteKey ? (
        <Script
          id="turnstile-login-script"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onReady={renderTurnstile}
        />
      ) : null}
      <form
        className="space-y-4 sm:space-y-6 mb-4 sm:mb-8"
        onSubmit={otpSent ? handleVerifyOtp : handleLogin}
      >
        <TextField
          id="email"
          aria-label="Email"
          placeholder="Email"
          type="email"
          shape="underline"
          size="lg"
          leadingIcon={<i className="ri-mail-line" aria-hidden="true"></i>}
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={otpSent}
        />
        {!otpSent ? (
          <div>
            <TextField
              id="password"
              aria-label="Password"
              placeholder="Password"
              type={showPassword ? "text" : "password"}
              shape="underline"
              size="lg"
              leadingIcon={<i className="ri-lock-line" aria-hidden="true"></i>}
              trailingIcon={
                <button
                  type="button"
                  className="text-field__toggle"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={
                    showPassword ? "パスワードを非表示" : "パスワードを表示"
                  }
                  aria-pressed={showPassword}
                >
                  <i
                    className={showPassword ? "ri-eye-line" : "ri-eye-off-line"}
                    aria-hidden="true"
                  ></i>
                </button>
              }
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="mt-2 text-right">
              <Link
                href="/auth/password-reset"
                className="text-[#474747] underline underline-offset-4 hover:text-black transition-colors"
                style={xsTextStyle}
              >
                パスワードをお忘れの方はこちら
              </Link>
            </div>
          </div>
        ) : null}
        {otpSent ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label
                htmlFor="otp"
                className="block tracking-widest"
                style={mdTextStyle}
              >
                認証コード
              </label>
              {timeRemaining > 0 ? (
                <span className="text-[#474747]" style={xsTextStyle}>
                  {formatOtpCountdown(timeRemaining)}
                </span>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs underline text-[#474747] hover:text-black transition-colors px-0 py-0"
                  style={xsTextStyle}
                  onClick={async () => {
                    setLoading(true);
                    setError(null);
                    try {
                      const res = await login(
                        email,
                        password,
                        turnstileToken || undefined,
                      );
                      if (!res.success) {
                        setError(res.error || "メール送信に失敗しました");
                      } else {
                        setOtpSentTime(new Date());
                        setTimeRemaining(60);
                        setOtpDigits([...EMPTY_OTP_DIGITS]);
                        setTimeout(() => focusOtpInput(0), 0);
                        setSuccess(
                          res.message || "認証コードを再送信しました。",
                        );
                      }
                    } catch (err) {
                      console.error("Unexpected OTP resend error", err);
                      setError("メール送信に失敗しました");
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  再送信
                </Button>
              )}
            </div>
            <div
              className="flex items-center justify-between gap-1.5 sm:gap-2"
              id="otp"
            >
              {Array.from({ length: OTP_LENGTH }).map((_, index) => (
                <input
                  key={index}
                  ref={(el) => {
                    otpInputRefs.current[index] = el;
                  }}
                  value={otpDigits[index]}
                  onChange={(event) =>
                    handleOtpChange(index, event.target.value)
                  }
                  onKeyDown={(event) => handleOtpKeyDown(index, event)}
                  onPaste={(event) => handleOtpPaste(index, event)}
                  className="flex-1 min-w-0 h-11 border border-black/20 rounded-lg text-center outline-none transition-colors duration-200 focus:border-black"
                  style={lgTextStyle}
                  type="text"
                  inputMode="numeric"
                  autoComplete={index === 0 ? "one-time-code" : "off"}
                  maxLength={1}
                  aria-label={`認証コード ${index + 1} 桁目`}
                />
              ))}
            </div>
          </div>
        ) : null}
        {siteKey ? (
          <div className="pt-2">
            <div ref={turnstileRef}></div>
          </div>
        ) : null}
        <Button
          type="submit"
          size="xl"
          className="w-full"
          style={{ minHeight: "3rem" }}
          disabled={
            loading ||
            (!otpSent && (!email || !password)) ||
            (otpSent && otpCode.length !== OTP_LENGTH)
          }
        >
          {loading ? "処理中..." : otpSent ? "サインイン" : "ログイン"}
        </Button>
        {otpSent ? (
          <Button
            type="button"
            variant="ghost"
            className="w-full py-3 border border-black/20 rounded-lg tracking-widest hover:bg-black/5 transition-all duration-300"
            style={mdTextStyle}
            onClick={() => {
              setOtpSent(false);
              setOtpSentTime(null);
              setTimeRemaining(0);
              setError(null);
              setSuccess(null);
              setOtpDigits([...EMPTY_OTP_DIGITS]);
            }}
            size="md"
          >
            メールアドレスを変更
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-red-600 mt-2" style={mdTextStyle}>
            {error}
          </p>
        ) : null}
        {success ? (
          <p
            role="status"
            className="mt-2 flex items-center gap-2"
            style={mdTextStyle}
          >
            <span aria-hidden="true">✓</span>
            {success}
          </p>
        ) : null}
      </form>
      <div className="relative mb-4 sm:mb-8">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-black/20"></div>
        </div>
        <div className="relative flex justify-center">
          <span
            className="px-4 bg-white text-[#474747] tracking-widest"
            style={xsTextStyle}
          >
            OR
          </span>
        </div>
      </div>
      <Button
        type="button"
        onClick={() => {
          void loginWithGoogle({ next: "/auth/verified" });
        }}
        variant="secondary"
        size="xl"
        className="w-full flex items-center justify-center gap-3"
        style={{ minHeight: "3rem" }}
      >
        <i className="ri-google-fill text-lg"></i>Googleでサインイン
      </Button>
    </div>
  );
};

export default LoginModal;
