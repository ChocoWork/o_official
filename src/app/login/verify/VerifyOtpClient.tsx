"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLogin } from "@/contexts/LoginContext";
import { Button } from "@/components/ui/Button/Button";
import { formatResendCountdown } from "@/lib/format-countdown";
import { maskEmail } from "@/lib/mask-email";
import "@/components/AuthForm.css";

const OTP_LENGTH = 8;
const EMPTY_OTP_DIGITS = Array.from({ length: OTP_LENGTH }, () => "");
const RESEND_COOLDOWN_SECONDS = 60;

type AuthMeResponse = {
  authenticated?: boolean;
  user?: {
    role?: unknown;
  };
};

const isPrivilegedRole = (role: unknown): boolean =>
  role === "admin" || role === "supporter";

/**
 * 認証コードの入力画面。
 *
 * 以前はログイン / 会員登録タブの中の一状態だった。state だけで持っていたため、
 * リロードすると資格情報フォームへ戻る一方でサーバー側の 2FA Cookie は生きており、
 * 再ログインすると 2 通目の OTP が飛んでアカウント制限を 1 回消費していた。
 * 状態を Cookie だけに寄せ、画面を独立させることでこの経路を閉じている。
 */
export default function VerifyOtpClient({ email }: { email: string }) {
  const router = useRouter();
  const { verifyOtp } = useLogin();
  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [otpDigits, setOtpDigits] = useState<string[]>(EMPTY_OTP_DIGITS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState(
    () => Date.now() + RESEND_COOLDOWN_SECONDS * 1000,
  );
  const [timeRemaining, setTimeRemaining] = useState(RESEND_COOLDOWN_SECONDS);

  const otpCode = otpDigits.join("");
  const maskedEmail = maskEmail(email);

  const focusOtpInput = useCallback((index: number) => {
    const input = otpInputRefs.current[index];
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

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

  // 残り時間は経過時刻から引き直す。setInterval の呼ばれた回数を数えると、
  // タブが背面に回って間引かれたぶんだけ再送可能になる時刻が後ろへずれる。
  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(
        0,
        Math.ceil((resendAvailableAt - Date.now()) / 1000),
      );
      setTimeRemaining(remaining);

      if (remaining === 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [resendAvailableAt]);

  const resolvePostLoginPath = useCallback(async (): Promise<string> => {
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

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();

    if (otpCode.length !== OTP_LENGTH) {
      setError("認証コードは8桁で入力してください");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await verifyOtp(otpCode);
      if (!res.success) {
        setError(res.error || "認証コードの確認に失敗しました");
        return;
      }
      router.replace(await resolvePostLoginPath());
    } catch (err) {
      console.error("Unexpected OTP verify error", err);
      setError("認証コードの確認に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  // 再送にパスワードは要らない。パスワード検証を通ったことは 2FA Cookie が
  // 証明しているので、宛先もリクエスト本文では送らない。
  const handleResend = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await fetch("/api/auth/login/resend", {
        method: "POST",
        credentials: "same-origin",
      });

      if (!resp.ok) {
        if (resp.status === 401) {
          router.replace("/login");
          return;
        }
        if (resp.status === 429) {
          const retryAfter = resp.headers.get("Retry-After");
          const seconds = retryAfter && /^\d+$/.test(retryAfter)
            ? Number(retryAfter)
            : (Date.parse(retryAfter ?? "") - Date.now()) / 1000;
          const waitSeconds = Number.isFinite(seconds) && seconds > 0
            ? Math.ceil(seconds)
            : RESEND_COOLDOWN_SECONDS;
          setResendAvailableAt(Date.now() + waitSeconds * 1000);
          setTimeRemaining(waitSeconds);
          setError("送信回数の上限に達しました。時間をおいて再度お試しください。");
        } else if (resp.status === 503) {
          setError("一時的に認証処理を利用できません。時間をおいて再度お試しください。");
        } else {
          setError("認証コードの送信に失敗しました");
        }
        return;
      }

      setOtpDigits([...EMPTY_OTP_DIGITS]);
      setResendAvailableAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      setTimeRemaining(RESEND_COOLDOWN_SECONDS);
      setSuccess("認証コードを再送信しました。");
      setTimeout(() => focusOtpInput(0), 0);
    } catch (err) {
      console.error("Unexpected OTP resend error", err);
      setError("認証コードの送信に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [router, focusOtpInput]);

  // クライアント状態を戻すだけでは Cookie が残る。サーバーに捨てさせる。
  const handleUseAnotherAddress = async () => {
    await fetch("/api/auth/login/cancel", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
    router.replace("/login");
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="px-6 text-center">
        <h1 className="font-brand lk-text-4xl tracking-widest">
          認証コードを入力
        </h1>
        {maskedEmail ? (
          <p className="mt-[5px] lk-text-sm leading-relaxed">
            {maskedEmail} 宛に送信しました
          </p>
        ) : null}
        <p className="mt-[5px] lk-text-sm leading-relaxed">
          コードは5分間有効です
        </p>

        <form className="mt-5" onSubmit={handleVerify}>
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
                onChange={(event) => handleOtpChange(index, event.target.value)}
                onKeyDown={(event) => handleOtpKeyDown(index, event)}
                onPaste={(event) => handleOtpPaste(index, event)}
                className="flex-1 min-w-0 h-11 border border-black/20 rounded-lg text-center lk-text-lg outline-none transition-colors duration-200 focus:border-black"
                type="text"
                inputMode="numeric"
                autoComplete={index === 0 ? "one-time-code" : "off"}
                maxLength={1}
                aria-label={`認証コード ${index + 1} 桁目`}
              />
            ))}
          </div>

          <Button
            type="submit"
            size="md"
            className="auth-action w-full mt-[30px]"
            disabled={loading || otpCode.length !== OTP_LENGTH}
          >
            {loading ? "処理中..." : "サインイン"}
          </Button>
        </form>

        <div className="mt-[30px]">
          {timeRemaining > 0 ? (
            <p className="lk-text-xs text-[#474747]">
              {formatResendCountdown(timeRemaining)}
            </p>
          ) : (
            <Button
              type="button"
              className="auth-action w-full"
              size="md"
              disabled={loading}
              onClick={handleResend}
            >
              再送信
            </Button>
          )}
        </div>

        {error ? (
          <p role="alert" className="mt-4 lk-text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {success ? (
          <p role="status" className="mt-4 lk-text-sm">
            {success}
          </p>
        ) : null}

        <div className="mt-[30px] flex items-center justify-center gap-6">
          <button
            type="button"
            onClick={handleUseAnotherAddress}
            className="lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
          >
            別のアドレスでやり直す
          </button>
        </div>
      </div>
    </div>
  );
}
