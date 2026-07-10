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

declare global {
  interface Window {
    onTurnstileReset?: (tokenValue: string) => void;
  }
}

// 見出しはページの最上位アンカー。対比の原則により最大サイズ（2xl）とする。
const headingTextStyle: React.CSSProperties = {
  fontSize: "var(--lk-size-2xl)",
};

export default function PasswordResetPage() {
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isConfirmMode, setIsConfirmMode] = useState(false);
  const [isResolvingSession, setIsResolvingSession] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [resetComplete, setResetComplete] = useState(false);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";

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

  useEffect(() => {
    if (!siteKey) return;
    window.onTurnstileReset = (tokenValue: string) =>
      setTurnstileToken(tokenValue);
    return () => {
      if (window.onTurnstileReset) {
        delete window.onTurnstileReset;
      }
    };
  }, [siteKey]);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

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
      const resp = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          turnstileToken: turnstileToken || undefined,
        }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        setError(body?.error || "送信に失敗しました");
        return;
      }

      setMessage(
        "パスワード再設定メールを送信しました。受信トレイをご確認ください。",
      );
    } catch (err) {
      console.error(err);
      setError("送信に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

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

      setMessage("パスワードを更新しました。");
      setIsConfirmMode(false);
      setResetComplete(true);
      setEmail("");
      setNewPassword("");
    } catch (err) {
      console.error(err);
      setError("再設定に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto px-4 sm:px-6 pt-2">
      {siteKey ? (
        <Script
          id="turnstile-reset-script"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
        />
      ) : null}
      <div className="px-6 pt-6 sm:pt-10 lg:pt-[55px]">
        <h1
          className="font-brand text-center tracking-widest mb-8"
          style={headingTextStyle}
        >
          パスワード再設定
        </h1>
        <form
          className="space-y-4 sm:space-y-6"
          onSubmit={isConfirmMode ? handleConfirm : handleRequest}
        >
          <TextField
            id="email"
            aria-label="Email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            type="email"
            autoComplete="email"
            disabled={isConfirmMode || isResolvingSession}
            shape="underline"
            size="lg"
            leadingIcon={<i className="ri-mail-line" aria-hidden="true"></i>}
          />

          {isConfirmMode ? (
            <TextField
              id="newPassword"
              aria-label="New Password"
              placeholder="New Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              helperText="8文字以上128文字以内"
              shape="underline"
              size="lg"
              leadingIcon={<i className="ri-lock-line" aria-hidden="true"></i>}
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
                    className={showPassword ? "ri-eye-line" : "ri-eye-off-line"}
                    aria-hidden="true"
                  ></i>
                </button>
              }
            />
          ) : siteKey ? (
            <div className="pt-2">
              <div
                className="cf-turnstile"
                data-sitekey={siteKey}
                data-callback="onTurnstileReset"
              ></div>
            </div>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            size="xl"
            style={{ minHeight: "3rem" }}
            disabled={
              loading ||
              isResolvingSession ||
              (isConfirmMode ? !newPassword : !email)
            }
          >
            {isResolvingSession
              ? "確認中..."
              : isConfirmMode
                ? "パスワードを更新"
                : "再設定メールを送信"}
          </Button>
        </form>
        {error ? (
          <p
            role="alert"
            className="text-sm text-red-600 mt-4 whitespace-pre-line"
          >
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-sm mt-4 flex items-center gap-2">
            <span aria-hidden="true">✓</span>
            {message}
          </p>
        ) : null}
        {resetComplete ? (
          <Link
            href="/login"
            className="mt-4 inline-block text-sm underline underline-offset-4 hover:text-[#474747] transition-colors"
          >
            ログインへ
          </Link>
        ) : null}
      </div>
    </div>
  );
}
