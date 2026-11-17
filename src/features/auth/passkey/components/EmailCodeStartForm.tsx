/**
 * メールのコードを受け取る入力欄とボタン（src/features/auth/passkey/components/EmailCodeStartForm.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-326
 * @design DD-AUTH-063
 * @remarks 202 なら `/login/code` へ置き換えて移る（履歴に残すと戻るでこの欄へ戻り、保留の Cookie のまま2通目を送れてしまう）。
 * 応答は未登録・登録済み・店員で同じなので、画面もアカウントの状態で変えない（SEC-AUTH-048）。
 * Turnstile のトークンは送った時点で使われるので、成否によらず引き直す（ADR-0411）。
 * no-store の応答は本文を読まないと Chrome が通信中のままにするので、どの道でも本文を読む。
 */
"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EmailCodeStartRequestSchema } from "@/features/auth/schemas/email-code";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { TextField } from "@/components/ui/TextField/TextField";
import "@/components/AuthForm.css";

const MSG_BOT = "ボット検証を完了してください";
const MSG_LIMITED = "試行が集中しています。しばらくしてからやり直してください。";
const MSG_FAILED = "確認コードを送れませんでした。時間をおいてやり直してください。";

type Props = {
  initialEmail?: string;
  returnTo?: string;
  /** 設定されている時だけ Turnstile を使う */
  siteKey: string;
  turnstileToken: string;
  turnstileRef: (node: HTMLDivElement | null) => void;
  resetTurnstile: () => void;
};

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

export default function EmailCodeStartForm({
  initialEmail = "",
  returnTo,
  siteKey,
  turnstileToken,
  turnstileRef,
  resetTurnstile,
}: Props) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const parsed = EmailCodeStartRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" "));
      return;
    }
    if (siteKey && !turnstileToken) {
      setError(MSG_BOT);
      return;
    }

    setLoading(true);
    setError(null);
    let moved = false;
    try {
      const response = await fetch("/api/auth/email-code/start", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(turnstileToken ? { turnstileToken } : {}),
          ...(returnTo ? { next: returnTo } : {}),
        }),
      });
      const body = await readBody(response);

      if (response.status === 202) {
        moved = true;
        router.replace("/login/code");
        return;
      }
      if (response.status === 400) {
        const message =
          typeof body?.error === "string"
            ? body.error
            : typeof body?.message === "string"
              ? body.message
              : MSG_FAILED;
        setError(message);
      } else if (response.status === 403 && body?.error === "Bot detection failed") {
        setError(MSG_BOT);
      } else if (response.status === 429) {
        setError(MSG_LIMITED);
      } else {
        setError(MSG_FAILED);
      }
    } catch {
      setError(MSG_FAILED);
    } finally {
      // 移る時は入力を止めたままにする（二重に送らない）。
      if (!moved) {
        setLoading(false);
        // 無効になった欄からフォーカスが落ちるので、失敗の後は欄へ戻す。
        setTimeout(() => document.getElementById("email")?.focus(), 0);
      }
      resetTurnstile();
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-busy={loading} noValidate>
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
          disabled={loading}
        />
        {siteKey ? (
          <div className="pt-2">
            <div ref={turnstileRef}></div>
          </div>
        ) : null}
        <Button
          type="submit"
          size="md"
          className="auth-action w-full"
          disabled={loading || !email}
          aria-busy={loading}
        >
          {loading ? "送信しています…" : "メールでコードを受け取る"}
        </Button>
      </div>
      <p className="mt-3 lk-text-xs leading-relaxed text-[#474747]">
        はじめての方も、同じ方法でアカウントを作れます。
      </p>
      <p className="mt-1 lk-text-xs leading-relaxed text-[#474747]">
        続けると、
        <Link href="/terms" className="underline underline-offset-4">
          利用規約
        </Link>{" "}
        と{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          プライバシーポリシー
        </Link>{" "}
        に同意したものとします。
      </p>
      <LiveMessage className="mt-2 lk-text-md text-red-600">{error}</LiveMessage>
    </form>
  );
}
