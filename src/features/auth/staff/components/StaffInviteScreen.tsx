/**
 * 店員の招待のリンクの画面（src/features/auth/staff/components/StaffInviteScreen.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-368
 * @design DD-AUTH-078
 * @remarks URL の `#` の合言葉を読み、読んだらすぐ `history.replaceState` で URL から消す（履歴・拡張機能に残さない）。
 * 画面を開いただけでは合言葉をサーバーに送らない（`#` はサーバーに届かない。メールの先読みでは何も起きない）。
 * ボタンを押した時だけ POST し（素の `fetch`。`clientFetch` の再試行で合言葉を2度送らない）、成功したら登録の画面へ移る。合言葉は画面にもログにも出さない。
 */
"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import "@/components/AuthForm.css";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MSG_BROKEN = "リンクが正しくありません。メールのリンクを、そのまま開いてください。";
const MSG_UNUSABLE = "このリンクは使えません。店長に、もう一度招待を出してもらってください。";
const MSG_FAILED = "登録を始められませんでした。店長に、もう一度招待を出してもらってください。";
const MSG_LIMITED = "試行が集中しています。しばらくしてからお試しください。";

type Failure = "unusable" | "failed" | "limited";

export default function StaffInviteScreen() {
  const router = useRouter();
  const tokenRef = useRef<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const readRef = useRef(false);

  useEffect(() => {
    // StrictMode は効果を2回走らせる。2回目は # が空なので、読むのは1回だけにする。
    if (readRef.current) return;
    readRef.current = true;
    const token = window.location.hash.replace(/^#/, "");
    if (token) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if (TOKEN_PATTERN.test(token)) tokenRef.current = token;
    else setBroken(true);
    setChecked(true);
  }, []);

  const start = async () => {
    // ボタンは合言葉が読めた時だけ描かれ、押すと無効になる。
    const token = tokenRef.current as string;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch("/api/auth/staff/invite/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        const to = (body as { redirectTo?: unknown } | null)?.redirectTo;
        router.replace(typeof to === "string" && to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") ? to : "/staff/register");
        return;
      }
      await response.body?.cancel();
      setFailure(response.status === 400 ? "unusable" : response.status === 429 || response.status === 503 ? "limited" : "failed");
    } catch {
      setFailure("failed");
    }
    setBusy(false);
  };

  if (!checked) return null;

  const message = broken
    ? MSG_BROKEN
    : failure === "unusable"
      ? MSG_UNUSABLE
      : failure === "limited"
        ? MSG_LIMITED
        : failure === "failed"
          ? MSG_FAILED
          : null;
  const spent = failure === "unusable" || failure === "failed";

  return (
    <div className="w-full max-w-md mx-auto px-6">
      <h1 tabIndex={-1} className="font-brand lk-text-4xl tracking-widest text-center outline-none">
        店員のパスキーを登録します
      </h1>
      <p className="mt-5 lk-text-sm leading-relaxed">
        次の画面で、この端末の顔認証・指紋・PIN でログインできる「パスキー」を2本登録します。
      </p>
      <p className="mt-2 lk-text-xs leading-relaxed text-[#474747]">
        別の端末か、セキュリティキーでの登録をおすすめします。
      </p>
      <p className="mt-2 lk-text-sm leading-relaxed">
        登録は30分以内に終えてください。このあいだ、管理画面は使えません。
      </p>

      <LiveMessage className="mt-4 lk-text-sm text-red-600">{message}</LiveMessage>

      {broken || spent ? null : (
        <div className="mt-6 flex flex-col gap-3">
          <Button
            type="button"
            size="md"
            className="auth-action w-full"
            id="staff-invite-start"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void start()}
          >
            {busy ? "確認しています…" : "登録を始める"}
          </Button>
        </div>
      )}
    </div>
  );
}
