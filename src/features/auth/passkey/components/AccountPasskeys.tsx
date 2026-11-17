/**
 * アカウントの「ログイン方法」タブのパスキー（src/features/auth/passkey/components/AccountPasskeys.tsx）。一覧・追加・名前の変更・削除。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-329
 * @design DD-AUTH-065
 * @remarks お客さん専用（呼び出す側が `userRole === 'user'` の時だけ置く）。窓口を呼ぶのは `passkey-client.ts`（本文は読み切る・捨てる）。
 * 成功・失敗の知らせは自動では消さない（WCAG 2.2.1）。フォーカスは、無効になったボタンから落ちた時だけ主のボタンへ戻す（ほかへ移していたら奪わない）。
 * `challenge_id`・`credential`・トークンは画面にもログにも出さない（`registerPasskey` が持つ）。
 */
"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { clientFetch } from "@/lib/client-fetch";
import {
  deletePasskey,
  listPasskeys,
  registerPasskey,
  renamePasskey,
  type ListedPasskey,
  type RegisterFailureReason,
} from "@/features/auth/passkey/passkey-client";
import { isPasskeySupported, requestAttestation } from "@/features/auth/passkey/webauthn-browser";
import { deviceNameFromUserAgent } from "@/features/auth/passkey/device-name";
import { buildLoginHref } from "@/features/auth/return-intent/use-login-href";

const MSG_LOAD_FAILED = "パスキーの一覧を読み込めませんでした。";
const MSG_ADDED = "パスキーを追加しました。";
const MSG_RENAME_FAILED = "名前を変更できませんでした。もう一度お試しください。";
const MSG_NAME_INVALID = "名前は1〜64字で入力してください。";
const MSG_DELETE_FAILED = "削除できませんでした。もう一度お試しください。";
const MSG_UNSUPPORTED_ADD = "この端末ではパスキーを追加できません。";
const MSG_EMPTY = "パスキーはまだありません。作ると、メールのコードを待たずにログインできます。";
const MSG_LAST_ONE = "最後のパスキーです。削除しても、メールのコードか Google でログインできます。";
const REAUTH_HREF = buildLoginHref("/account?tab=security", "http://localhost");

function addFailureMessage(reason: RegisterFailureReason): string {
  switch (reason) {
    case "cancelled":
      return "パスキーの作成を中止しました。";
    case "already_registered":
      return "この端末のパスキーは、すでにアカウントに登録されています。";
    case "unsupported":
      return "この端末ではパスキーを作れません。";
    case "reauth_required":
      return "安全のため、メールのコードでもう一度ログインしてから追加してください。";
    case "unauthorized":
      return "もう一度ログインしてください。";
    case "rate_limited":
      return "試行が集中しています。しばらくしてからやり直してください。";
    case "unavailable":
      return "ただいまパスキーを作れません。時間をおいてお試しください。";
    default:
      return "うまく作れませんでした。もう一度お試しください。";
  }
}

const JST_DATE = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** 日本時間の「YYYY年M月D日」。 */
function formatJstDate(iso: string): string {
  const parts = JST_DATE.formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${pick("year")}年${pick("month")}月${pick("day")}日`;
}

export default function AccountPasskeys() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [passkeys, setPasskeys] = useState<ListedPasskey[]>([]);
  const [supported, setSupported] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ListedPasskey | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addFailure, setAddFailure] = useState<RegisterFailureReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refocusAdd, setRefocusAdd] = useState(false);

  useEffect(() => {
    setSupported(isPasskeySupported());
  }, []);

  const load = useCallback(async () => {
    setStatus("loading");
    const result = await listPasskeys();
    if (result.ok) {
      setPasskeys(result.passkeys);
      setStatus("ready");
    } else {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 追加の間は無効になるので、ボタンが戻ってから落ちたままなら戻す（ほかへ移していたら奪わない）。
  useEffect(() => {
    if (!refocusAdd || adding) return;
    if (document.activeElement === document.body) document.getElementById("account-passkey-add")!.focus();
    setRefocusAdd(false);
  }, [refocusAdd, adding]);

  const handleAdd = async () => {
    setAdding(true);
    setAddFailure(null);
    setDeleteError(null);
    setNotice(null);
    try {
      const result = await registerPasskey({
        fetchApi: clientFetch,
        create: requestAttestation,
        deviceName: deviceNameFromUserAgent(navigator.userAgent),
      });
      if (result.ok) {
        setNotice(MSG_ADDED);
        await load();
      } else {
        setAddFailure(result.reason);
      }
    } catch {
      setAddFailure("failed");
    }
    setAdding(false);
    setRefocusAdd(true);
  };

  const startEdit = (passkey: ListedPasskey) => {
    setEditingId(passkey.id);
    setDraft(passkey.friendly_name ?? "");
    setRenameError(null);
    setNotice(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setRenameError(null);
  };

  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    const id = editingId!;
    const name = draft.trim();
    if (name.length === 0 || [...name].length > 64) {
      setRenameError(MSG_NAME_INVALID);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    const result = await renamePasskey(id, name);
    setRenameBusy(false);
    if (result.ok) {
      setPasskeys((current) =>
        current.map((item) => (item.id === id ? { ...item, friendly_name: result.passkey.friendly_name } : item)),
      );
      setEditingId(null);
    } else {
      setRenameError(MSG_RENAME_FAILED);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget!;
    setDeleteTarget(null);
    setNotice(null);
    setDeleteError(null);
    const result = await deletePasskey(target.id);
    if (result.ok) {
      setPasskeys((current) => current.filter((item) => item.id !== target.id));
    } else {
      setDeleteError(MSG_DELETE_FAILED);
    }
  };

  return (
    <div className="account-sections">
      <div className="account-card account-groups">
        <h2 className="account-heading">パスキー</h2>
        <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-md)" }}>
          パスキーを登録すると、この端末の顔認証・指紋・PIN でログインできます。
        </p>

        {status === "loading" ? (
          <div className="animate-pulse" aria-hidden="true" data-testid="account-passkeys-loading">
            <div className="h-4 w-2/3 bg-black/8 mb-3" />
            <div className="h-3 w-1/2 bg-black/8" />
          </div>
        ) : null}

        {status === "error" ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-red-600" style={{ fontSize: "var(--lk-size-md)" }}>
              {MSG_LOAD_FAILED}
            </p>
            <Button type="button" variant="outline" size="md" onClick={() => void load()}>
              再読み込み
            </Button>
          </div>
        ) : null}

        {status === "ready" && passkeys.length === 0 ? (
          <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-md)" }}>
            {MSG_EMPTY}
          </p>
        ) : null}

        {status === "ready" && passkeys.length > 0 ? (
          <ul className="flex flex-col gap-4">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="border-t border-black/10 pt-4 flex flex-col gap-3 min-w-0">
                {editingId === passkey.id ? (
                  <form onSubmit={(event) => void saveName(event)} className="flex flex-col gap-3">
                    <label htmlFor={`passkey-name-${passkey.id}`} className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                      名前
                    </label>
                    <input
                      id={`passkey-name-${passkey.id}`}
                      type="text"
                      value={draft}
                      autoFocus
                      autoComplete="off"
                      aria-invalid={renameError === MSG_NAME_INVALID ? true : undefined}
                      onChange={(event) => setDraft(event.target.value)}
                      className="w-full border border-black/30 px-3 py-2 min-h-11"
                    />
                    <LiveMessage className="text-red-600" style={{ fontSize: "var(--lk-size-sm)" }}>
                      {renameError}
                    </LiveMessage>
                    <div className="flex flex-wrap gap-3">
                      <Button type="submit" size="md" disabled={renameBusy} aria-busy={renameBusy}>
                        保存
                      </Button>
                      <Button type="button" variant="outline" size="md" disabled={renameBusy} onClick={cancelEdit}>
                        キャンセル
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0">
                      <p className="break-words" style={{ fontSize: "var(--lk-size-lg)" }}>
                        {passkey.friendly_name ?? "名前なし"}
                      </p>
                      <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                        {formatJstDate(passkey.created_at)} に作成
                      </p>
                      {passkey.last_used_at ? (
                        <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                          最後に使った日: {formatJstDate(passkey.last_used_at)}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="md"
                        aria-label={`${passkey.friendly_name ?? "名前なし"}の名前を変更`}
                        onClick={() => startEdit(passkey)}
                      >
                        名前を変更
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="md"
                        aria-label={`${passkey.friendly_name ?? "名前なし"}を削除`}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(passkey);
                        }}
                      >
                        削除
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <LiveMessage className="text-red-600" style={{ fontSize: "var(--lk-size-md)" }}>
          {deleteError ?? (addFailure ? addFailureMessage(addFailure) : null)}
        </LiveMessage>
        <LiveMessage politeness="status" style={{ fontSize: "var(--lk-size-md)" }}>
          {notice}
        </LiveMessage>

        {status !== "loading" ? (
          <div className="flex flex-col items-start gap-3">
            {addFailure === "reauth_required" ? (
              <Button href={REAUTH_HREF} variant="primary" size="md">
                メールのコードでログイン
              </Button>
            ) : null}
            <Button
              type="button"
              id="account-passkey-add"
              size="md"
              disabled={adding || !supported}
              aria-busy={adding}
              onClick={() => void handleAdd()}
            >
              {adding ? "追加しています…" : "パスキーを追加"}
            </Button>
            {!supported ? (
              <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                {MSG_UNSUPPORTED_ADD}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="このパスキーを削除しますか"
        description={`削除すると、このパスキーではログインできなくなります。${passkeys.length === 1 ? MSG_LAST_ONE : ""}`}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
