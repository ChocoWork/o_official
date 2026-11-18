/**
 * メールのコードを入力してログインを確定する部品（src/features/auth/passkey/components/EmailCodeEntry.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-314
 * @design DD-AUTH-062
 * @remarks 旧 `VerifyOtpClient` の入力・カウントダウンの動きを写し、窓口を `/api/auth/email-code/*` に替えた（共有に直さない）。
 * 成功の行き先は確定の応答の `offerPasskey` だけで決める（別の呼び出しをしない。窓口が失敗側に倒れた時は静かに「勧めない」へ退く）。
 * no-store の応答は本文を読まないと Chrome が通信中のままにするので、どの道でも本文を読むか捨てる。
 */
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLogin } from "@/contexts/LoginContext";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { formatResendCountdown } from "@/lib/format-countdown";
import { maskEmail } from "@/lib/mask-email";
import { isPasskeySupported } from "@/features/auth/passkey/webauthn-browser";
import { resolvePostLoginPath } from "@/features/auth/passkey/post-login";
import { staffPasskeyRequiredMessage } from "@/features/auth/passkey/staff-passkey-message";
import "@/components/AuthForm.css";

const CODE_LENGTH = 8;
const EMPTY_DIGITS = Array.from({ length: CODE_LENGTH }, () => "");
const RESEND_COOLDOWN_SECONDS = 60;
const BASE = "/api/auth/email-code";

const MSG_INVALID = "確認コードが無効、または期限切れです。";
const MSG_LIMITED = "試行が集中しています。しばらくしてからやり直してください。";
const MSG_EXPIRED = "時間がたちました。もう一度メールアドレスを入れてください。";
const MSG_VERIFY_FAILED = "確認できませんでした。時間をおいて、もう一度お試しください。";
const MSG_RESEND_LIMITED = "しばらく再送できません。時間をおいて、もう一度お試しください。";
const MSG_UNAVAILABLE = "ただいま処理できません。時間をおいて、もう一度お試しください。";
const MSG_RESEND_FAILED = "確認コードを送れませんでした。時間をおいて、もう一度お試しください。";
const MSG_RESENT = "確認コードを再送しました。";

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function retryAfterSeconds(response: Response): number {
  const header = response.headers.get("Retry-After");
  const seconds =
    header && /^\d+$/.test(header) ? Number(header) : (Date.parse(header ?? "") - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : RESEND_COOLDOWN_SECONDS;
}

export default function EmailCodeEntry({ email }: { email: string }) {
  const router = useRouter();
  const { refreshAuthState } = useLogin();
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const returnRef = useRef<HTMLButtonElement | null>(null);
  const [digits, setDigits] = useState<string[]>(EMPTY_DIGITS);
  const [loading, setLoading] = useState(false);
  const [closed, setClosed] = useState(false);
  const [done, setDone] = useState(false);
  const [staffBlocked, setStaffBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState(
    () => Date.now() + RESEND_COOLDOWN_SECONDS * 1000,
  );
  const [timeRemaining, setTimeRemaining] = useState(RESEND_COOLDOWN_SECONDS);

  const code = digits.join("");
  const maskedEmail = maskEmail(email);
  const inactive = loading || closed || done;

  const focusInput = useCallback((index: number) => {
    const input = inputRefs.current[index];
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  useEffect(() => {
    focusInput(0);
  }, [focusInput]);

  // 残り時間は経過時刻から引き直す（背面のタブで setInterval が間引かれても再送の時刻がずれない）。
  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000));
      setTimeRemaining(remaining);
      if (remaining === 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [resendAvailableAt]);

  // 閉じた時は、読み上げと操作の起点を「ログイン画面へ戻る」へ移す（自動では戻さない）。
  useEffect(() => {
    if (closed) returnRef.current!.focus();
  }, [closed]);

  const fillFrom = (index: number, text: string) => {
    const numbersOnly = text.replace(/\D/g, "");
    if (!numbersOnly) return false;
    setDigits((prev) => {
      const next = [...prev];
      let cursor = index;
      for (const digit of numbersOnly) {
        if (cursor >= CODE_LENGTH) break;
        next[cursor] = digit;
        cursor += 1;
      }
      return next;
    });
    focusInput(Math.min(index + numbersOnly.length, CODE_LENGTH - 1));
    return true;
  };

  const handleChange = (index: number, value: string) => {
    if (fillFrom(index, value)) return;
    setDigits((prev) => {
      const next = [...prev];
      next[index] = "";
      return next;
    });
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      setDigits((prev) => {
        const next = [...prev];
        if (next[index]) {
          next[index] = "";
          return next;
        }
        if (index > 0) {
          next[index - 1] = "";
          setTimeout(() => focusInput(index - 1), 0);
        }
        return next;
      });
      return;
    }
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      focusInput(index - 1);
    }
    if (event.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      event.preventDefault();
      focusInput(index + 1);
    }
  };

  const handlePaste = (index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    fillFrom(index, event.clipboardData.getData("text"));
  };

  const closeWith = (message: string) => {
    setError(message);
    setSuccess(null);
    setClosed(true);
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inactive || code.length !== CODE_LENGTH) return;

    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`${BASE}/verify`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await readBody(response);

      if (response.ok) {
        // 移動が終わるまで入力と送信を止めたままにする（二度目の確定は保留が無く 401 になる）。
        setDone(true);
        await refreshAuthState();
        if (body?.offerPasskey === true && isPasskeySupported()) {
          router.replace("/login/passkey");
        } else {
          router.replace(await resolvePostLoginPath());
        }
        return;
      }
      if (response.status === 401) {
        const expired = typeof body?.error === "string" && body.error.startsWith("セッションの有効期限");
        if (expired) closeWith(MSG_EXPIRED);
        else {
          setError(MSG_INVALID);
          focusInput(0);
        }
      } else if (response.status === 429) {
        closeWith(MSG_LIMITED);
      } else if (response.status === 403 && body?.error === "staff_passkey_required") {
        setStaffBlocked(true);
        closeWith(staffPasskeyRequiredMessage());
      } else {
        setError(MSG_VERIFY_FAILED);
      }
    } catch {
      setDone(false);
      setError(MSG_VERIFY_FAILED);
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`${BASE}/resend`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
      });
      await response.arrayBuffer().catch(() => undefined);

      if (response.ok) {
        setDigits([...EMPTY_DIGITS]);
        setResendAvailableAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
        setTimeRemaining(RESEND_COOLDOWN_SECONDS);
        setSuccess(MSG_RESENT);
        setTimeout(() => focusInput(0), 0);
      } else if (response.status === 401) {
        closeWith(MSG_EXPIRED);
      } else if (response.status === 429) {
        const wait = retryAfterSeconds(response);
        setResendAvailableAt(Date.now() + wait * 1000);
        setTimeRemaining(wait);
        setError(MSG_RESEND_LIMITED);
      } else if (response.status === 503) {
        setError(MSG_UNAVAILABLE);
      } else {
        setError(MSG_RESEND_FAILED);
      }
    } catch {
      setError(MSG_RESEND_FAILED);
    } finally {
      setLoading(false);
    }
  };

  // クライアントの状態を戻すだけでは Cookie が残る。サーバーに捨てさせる。
  const handleCancel = async () => {
    try {
      const response = await fetch(`${BASE}/cancel`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
      });
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      // 取りやめの失敗は握る。画面は戻す。
    }
    router.replace("/login");
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="px-6 text-center">
        <h1 className="font-brand lk-text-4xl tracking-widest">確認コードを入力してください</h1>
        {maskedEmail ? (
          <p className="mt-[5px] lk-text-sm leading-relaxed">
            {maskedEmail} に8桁のコードをお送りしました。5分以内に入力してください。
          </p>
        ) : null}
        <p className="mt-[5px] lk-text-xs leading-relaxed text-[#474747]">
          コードの無い確認のメールが届いた時は、そのメールのリンクを押してから、もう一度お試しください。
        </p>

        <form className="mt-5" onSubmit={handleVerify} aria-busy={loading}>
          <div className="flex items-center justify-between gap-1.5 sm:gap-2" id="code">
            {Array.from({ length: CODE_LENGTH }).map((_, index) => (
              <input
                key={index}
                ref={(el) => {
                  inputRefs.current[index] = el;
                }}
                value={digits[index]}
                onChange={(event) => handleChange(index, event.target.value)}
                onKeyDown={(event) => handleKeyDown(index, event)}
                onPaste={(event) => handlePaste(index, event)}
                className="flex-1 min-w-0 h-11 border border-black/20 rounded-lg text-center lk-text-lg outline-none transition-colors duration-200 focus:border-black"
                type="text"
                inputMode="numeric"
                autoComplete={index === 0 ? "one-time-code" : "off"}
                maxLength={1}
                disabled={closed}
                aria-label={`確認コード ${index + 1}桁目`}
              />
            ))}
          </div>

          <Button
            type="submit"
            size="md"
            className="auth-action w-full mt-[30px]"
            disabled={inactive || code.length !== CODE_LENGTH}
          >
            ログイン
          </Button>
        </form>

        {staffBlocked ? null : (
          <div className="mt-[30px]">
            {timeRemaining > 0 && !closed ? (
              <p className="lk-text-xs text-[#474747] mb-2">{formatResendCountdown(timeRemaining)}</p>
            ) : null}
            <Button
              type="button"
              className="auth-action w-full"
              size="md"
              disabled={inactive || timeRemaining > 0}
              onClick={handleResend}
            >
              コードを再送する
            </Button>
          </div>
        )}

        <LiveMessage className="mt-4 lk-text-sm text-red-600">{error}</LiveMessage>
        <LiveMessage politeness="status" className="mt-4 lk-text-sm">
          {success}
        </LiveMessage>

        <div className="mt-[30px] flex items-center justify-center gap-6">
          {closed ? (
            <button
              ref={returnRef}
              type="button"
              onClick={() => router.replace("/login")}
              className="min-h-11 px-2 inline-flex items-center lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
            >
              ログイン画面へ戻る
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCancel}
              disabled={loading || done}
              className="min-h-11 px-2 inline-flex items-center lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
            >
              メールアドレスを入れ直す
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
