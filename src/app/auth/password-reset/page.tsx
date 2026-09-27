"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import {
  ResetRequestSchema,
  ResetSessionConfirmSchema,
} from "@/features/auth/schemas/password-reset";
import { z } from "zod";
import { Button } from "@/components/ui/Button/Button";
import { TextField } from "@/components/ui/TextField/TextField";
import {
  AuthResultScreen,
  MailSentIcon,
  PasswordUpdatedIcon,
} from "@/components/AuthResultScreen";
import { useTurnstileWidget } from "@/hooks/useTurnstileWidget";
import { formatResendCountdown } from "@/lib/format-countdown";
import "@/components/AuthForm.css";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";

// 再送の間隔。ログインの OTP 再送と同じ値にして、待ち時間の作法を 1 つに揃える。
const RESEND_COOLDOWN_SECONDS = 60;

// Retry-After が読めなかったときの保険。アカウント単位の制限窓（1 時間）に合わせる。
const RATE_LIMIT_FALLBACK_SECONDS = 3600;

export default function PasswordResetPage() {
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isConfirmMode, setIsConfirmMode] = useState(false);
  const [isResolvingSession, setIsResolvingSession] = useState(true);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [resetComplete, setResetComplete] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [requestSentAt, setRequestSentAt] = useState<Date | null>(null);
  const [cooldownStartedAt, setCooldownStartedAt] = useState<Date | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(
    RESEND_COOLDOWN_SECONDS,
  );
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [rateLimited, setRateLimited] = useState(false);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
  const {
    containerRef: turnstileRef,
    renderWidget: renderTurnstile,
    resetWidget: resetTurnstile,
  } = useTurnstileWidget(siteKey, setTurnstileToken);

  // link ルートは失敗理由を ?error= で返す。以前は無言でこの画面に戻していたため、
  // 期限切れなのか使用済みなのか分からず、利用者が同じ操作を繰り返すことになっていた。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("error");
    if (!reason) return;

    setLinkError(
      reason === "link_expired"
        ? "リンクの有効期限が切れているか、すでに使用されています。お手数ですが、再度メールを送信してください。"
        : "リンクが正しくありません。お手数ですが、再度メールを送信してください。",
    );
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    let active = true;

    const resolveResetSession = async () => {
      try {
        const response = await fetch("/api/auth/password-reset/session", {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          return;
        }

        const body = await response.json().catch(() => null);
        if (!active || !body) {
          return;
        }

        if (body.ready) {
          setIsConfirmMode(true);
          setEmail(typeof body.email === "string" ? body.email : "");
        } else {
          setIsConfirmMode(false);
        }
      } catch {
        if (active) {
          setIsConfirmMode(false);
        }
      } finally {
        if (active) {
          setIsResolvingSession(false);
        }
      }
    };

    void resolveResetSession();

    return () => {
      active = false;
    };
  }, []);

  // 残り時間は経過時刻から引き直す。setInterval の呼ばれた回数を数えると、
  // タブが背面に回って間引かれたぶんだけ再送可能になる時刻が後ろへずれる。
  useEffect(() => {
    if (!cooldownStartedAt) return;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - cooldownStartedAt.getTime()) / 1000;
      const remaining = Math.max(0, cooldownSeconds - Math.floor(elapsed));
      setCooldownRemaining(remaining);

      if (remaining === 0) {
        setRateLimited(false);
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [cooldownStartedAt, cooldownSeconds]);

  const startCooldown = (seconds: number) => {
    setCooldownSeconds(seconds);
    setCooldownRemaining(seconds);
    setCooldownStartedAt(new Date());
  };

  const requestResetMail = async () => {
    const resp = await fetch("/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        turnstileToken: turnstileToken || undefined,
      }),
    });

    if (resp.ok) {
      return { ok: true as const };
    }

    const retryAfter = Number(resp.headers.get("Retry-After"));
    const body = await resp.json().catch(() => null);
    return {
      ok: false as const,
      status: resp.status,
      retryAfter:
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      error: typeof body?.error === "string" ? body.error : undefined,
    };
  };

  const markMailSent = () => {
    setRequestSentAt(new Date());
    startCooldown(RESEND_COOLDOWN_SECONDS);
  };

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLinkError(null);

    try {
      ResetRequestSchema.parse({
        email,
        turnstileToken: turnstileToken || undefined,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.issues.map((i) => i.message).join("\n"));
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
    try {
      const result = await requestResetMail();

      if (!result.ok) {
        setError(
          result.status === 429
            ? "送信回数の上限に達しました。しばらく時間をおいてからお試しください。"
            : result.error || "送信に失敗しました",
        );
        return;
      }

      setRateLimited(false);
      markMailSent();
    } catch (err) {
      console.error(err);
      setError("送信に失敗しました");
    } finally {
      setLoading(false);
      // トークンは送信時点で消費済み。引き直さないと送信失敗後の再試行が 403 になる。
      resetTurnstile();
    }
  };

  const handleResend = async () => {
    setError(null);

    if (siteKey && !turnstileToken) {
      setError("ボット検証を完了してください");
      return;
    }

    setLoading(true);
    try {
      const result = await requestResetMail();

      if (!result.ok) {
        // 上限に当たったら再送ボタンを引っ込める。押せるまま無言で失敗させると、
        // 届かない理由が利用者側から一切分からない。
        if (result.status === 429) {
          setRateLimited(true);
          startCooldown(result.retryAfter ?? RATE_LIMIT_FALLBACK_SECONDS);
        } else {
          setError(result.error || "送信に失敗しました");
        }
        return;
      }

      markMailSent();
    } catch (err) {
      console.error(err);
      setError("送信に失敗しました");
    } finally {
      setLoading(false);
      resetTurnstile();
    }
  };

  const handleUseAnotherAddress = () => {
    setRequestSentAt(null);
    setCooldownStartedAt(null);
    setCooldownRemaining(0);
    setRateLimited(false);
    setError(null);
    setTurnstileToken("");
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      ResetSessionConfirmSchema.parse({ new_password: newPassword });
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.issues.map((i) => i.message).join("\n"));
      } else {
        setError("入力に誤りがあります");
      }
      return;
    }

    // 一致確認は長さの検証より後に置く。先にすると、短いパスワードを 2 回同じに
    // 打った人が「一致しません」を見て直したあと、改めて長さで弾かれる。
    if (newPassword !== confirmPassword) {
      setError("パスワードが一致しません");
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: newPassword }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        setError(body?.error || "再設定に失敗しました");
        return;
      }

      setIsConfirmMode(false);
      setResetComplete(true);
      setEmail("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      console.error(err);
      setError("再設定に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const renderResendAction = () => {
    // 上限に達したときの案内は、呼び出し側の常に置いた入れ物（LiveMessage）が出す（FREQ-376）
    if (rateLimited) {
      return null;
    }

    if (cooldownRemaining > 0) {
      return (
        <p className="lk-text-xs text-[#474747]">
          {formatResendCountdown(cooldownRemaining)}
        </p>
      );
    }

    // Turnstile は待ち時間が明けてから出す。完了直後に並べると、検証ウィジェットの
    // 「成功しました」が本来の送信完了より目立ってしまう。
    return (
      <div className="auth-form-grid auth-form-grid--result">
        {siteKey ? <div ref={turnstileRef}></div> : null}
        <Button
          type="button"
          className="auth-action w-full"
          size="md"
          disabled={loading || (!!siteKey && !turnstileToken)}
          onClick={handleResend}
        >
          {loading ? "送信中..." : "再送信する"}
        </Button>
      </div>
    );
  };

  return (
    <div className="w-full max-w-md mx-auto">
      {siteKey ? (
        <Script
          id="turnstile-reset-script"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onReady={renderTurnstile}
        />
      ) : null}
      <div className="px-6">
        {/* 結果画面では結果そのものが見出しになる。ページ見出しを残すと h1 が
            2 つ並び、画面で最も強い要素がどちらなのか読めなくなる。 */}
        {resetComplete || requestSentAt ? null : (
          <h1 className="mb-[21px] text-center font-brand lk-text-lg tracking-widest sm:mb-[34px]">
            パスワード再設定
          </h1>
        )}
        {resetComplete ? (
          <AuthResultScreen
            icon={<PasswordUpdatedIcon />}
            title="パスワードを更新しました"
            detail="新しいパスワードでログインしてください。"
            action={
              <Button href="/login" className="auth-action w-full" size="md">
                ログインへ
              </Button>
            }
          />
        ) : requestSentAt ? (
          <AuthResultScreen
            icon={<MailSentIcon />}
            title="再設定メールを送信しました"
            detail={
              <>
                <span className="block">
                  メール内のリンクから再設定してください。
                </span>
              </>
            }
            note={
              /* 各行 17 文字以内に収める。iPhone SE（375px）のテキスト列は
                 221.8px、文字サイズは 12.41px で 1 行 17.8 文字が上限のため、
                 これを超える行はどの画面幅でも折り返す。 */
              <>
                <span className="block">メールが届かない場合は、</span>
                <span className="block">
                  迷惑メールフォルダをご確認ください
                </span>
                <span className="block">
                  再送信すると前回のリンクは無効です
                </span>
              </>
            }
            action={
              <>
                <LiveMessage className="lk-text-xs text-red-600">
                  {rateLimited
                    ? "送信回数の上限に達しました。しばらく時間をおいてからお試しください。"
                    : null}
                </LiveMessage>
                {renderResendAction()}
                <LiveMessage className="mt-4 lk-text-xs text-red-600 whitespace-pre-line">
                  {error}
                </LiveMessage>
              </>
            }
            links={
              <>
                <button
                  type="button"
                  onClick={handleUseAnotherAddress}
                  className="lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
                >
                  別のアドレスで送信
                </button>
                <Link
                  href="/login"
                  className="lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
                >
                  ログインへ
                </Link>
              </>
            }
          />
        ) : (
          <>
            <form
              className="auth-form-grid"
              onSubmit={isConfirmMode ? handleConfirm : handleRequest}
            >
              {/* 宛先は直前に本人が入力した値で、ここでは変更もできない。
                  読み取り専用の欄を残すと、入力すべき欄がどれか分かりにくくなる。 */}
              {isConfirmMode ? null : (
                <TextField
                  id="email"
                  aria-label="Email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  type="email"
                  autoComplete="email"
                  disabled={isResolvingSession}
                  shape="underline"
                  size="sm"
                  leadingIcon={
                    <i className="ri-mail-line" aria-hidden="true"></i>
                  }
                />
              )}

              {isConfirmMode ? (
                <TextField
                  id="newPassword"
                  aria-label="New Password (16+ characters)"
                  placeholder="New Password (16+ characters)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  shape="underline"
                  size="sm"
                  leadingIcon={
                    <i className="ri-lock-line" aria-hidden="true"></i>
                  }
                  trailingIcon={
                    <button
                      type="button"
                      className="text-field__toggle"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={
                        showPassword ? "パスワードを非表示" : "パスワードを表示"
                      }
                      aria-pressed={showPassword}
                    >
                      <i
                        className={
                          showPassword ? "ri-eye-line" : "ri-eye-off-line"
                        }
                        aria-hidden="true"
                      ></i>
                    </button>
                  }
                />
              ) : siteKey ? (
                <div className="pt-2">
                  <div ref={turnstileRef}></div>
                </div>
              ) : null}

              {/* 打ち間違いを捕まえるための入力補助。作法は会員登録の
                  Confirm Password 欄と同じものを繰り返す。 */}
              {isConfirmMode ? (
                <TextField
                  id="confirmNewPassword"
                  aria-label="Confirm New Password (16+ characters)"
                  placeholder="Confirm New Password (16+ characters)"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password"
                  shape="underline"
                  size="sm"
                  leadingIcon={
                    <i className="ri-lock-line" aria-hidden="true"></i>
                  }
                  trailingIcon={
                    <button
                      type="button"
                      className="text-field__toggle"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      aria-label={
                        showConfirmPassword
                          ? "確認用パスワードを非表示"
                          : "確認用パスワードを表示"
                      }
                      aria-pressed={showConfirmPassword}
                    >
                      <i
                        className={
                          showConfirmPassword
                            ? "ri-eye-line"
                            : "ri-eye-off-line"
                        }
                        aria-hidden="true"
                      ></i>
                    </button>
                  }
                />
              ) : null}

              <Button
                type="submit"
                className="auth-action w-full"
                size="md"
                disabled={
                  loading ||
                  isResolvingSession ||
                  (isConfirmMode ? !newPassword || !confirmPassword : !email)
                }
              >
                {isResolvingSession
                  ? "確認中..."
                  : isConfirmMode
                    ? "パスワードを更新"
                    : "再設定メールを送信"}
              </Button>
            </form>
            <LiveMessage className="lk-text-sm text-red-600 mt-4 whitespace-pre-line">
              {linkError}
            </LiveMessage>
            <LiveMessage className="lk-text-sm text-red-600 mt-4 whitespace-pre-line">
              {error}
            </LiveMessage>
          </>
        )}
      </div>
    </div>
  );
}
