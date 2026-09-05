"use client";

import React, { useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { useLogin } from "@/contexts/LoginContext";
import { z } from "zod";
import { LoginRequestSchema } from "@/features/auth/schemas/login";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { TextField } from "@/components/ui/TextField/TextField";
import { useTurnstileWidget } from "@/hooks/useTurnstileWidget";
import "@/components/AuthForm.css";

interface LoginModalProps {
  open: boolean;
  onClose?: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ open, onClose }) => {
  const { login, loginWithGoogle } = useLogin();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
  const {
    containerRef: turnstileRef,
    renderWidget: renderTurnstile,
    resetWidget: resetTurnstile,
  } = useTurnstileWidget(siteKey, setTurnstileToken);

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
    try {
      const res = await login(email, password, turnstileToken || undefined);
      if (!res.success) {
        setError(res.error || "ログインに失敗しました");
      } else {
        // 検証は専用画面で行う。push だと戻るボタンで資格情報フォームへ戻れて
        // しまい、生きた 2FA Cookie を持ったまま再ログインして 2 通目の OTP を
        // 発射できる。replace で戻り先を残さない。
        onClose?.();
        router.replace("/login/verify");
      }
    } catch (err) {
      console.error("Unexpected login error", err);
      setError("ログインに失敗しました");
    } finally {
      setLoading(false);
      // トークンは送信時点で消費済み。引き直さないと再試行も再送信も 403 になる。
      resetTurnstile();
    }
  };

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
      <form className="mb-4 sm:mb-8" onSubmit={handleLogin}>
        <div className="auth-form-grid">
          <TextField
            id="email"
            aria-label="Email"
            placeholder="Email"
            type="email"
            shape="underline"
            size="sm"
            leadingIcon={<i className="ri-mail-line" aria-hidden="true"></i>}
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
                id="password"
                aria-label="Password"
                placeholder="Password"
                type={showPassword ? "text" : "password"}
                shape="underline"
                size="sm"
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
              <div
                data-auth-support-row
                className="auth-support-row auth-support-row--link text-right"
              >
                <Link
                  href="/auth/password-reset"
                  className="lk-text-xs text-[#474747] underline underline-offset-4 hover:text-black transition-colors"
                >
                  パスワードをお忘れの方はこちら
                </Link>
              </div>
          {siteKey ? (
            <div className="pt-2">
              <div ref={turnstileRef}></div>
            </div>
          ) : null}
          <Button
            type="submit"
            size="md"
            className="auth-action w-full"
            disabled={loading || !email || !password}
          >
            {loading ? "処理中..." : "ログイン"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 lk-text-md text-red-600">
            {error}
          </p>
        ) : null}
      </form>
      <div className="relative mb-4 sm:mb-8">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-black/20"></div>
        </div>
        <div className="relative flex justify-center">
          <span
            className="px-4 bg-white lk-text-xs text-[#474747] tracking-widest"
          >
            OR
          </span>
        </div>
      </div>
      <div data-auth-alternate role="group" aria-label="その他のログイン方法">
        <Button
          type="button"
          onClick={() => {
            void loginWithGoogle({ next: "/auth/verified" });
          }}
          variant="outline"
          size="md"
          className="auth-action w-full"
        >
          <i className="ri-google-fill lk-text-2xl" aria-hidden="true"></i>
          Googleでサインイン
        </Button>
      </div>
    </div>
  );
};

export default LoginModal;
