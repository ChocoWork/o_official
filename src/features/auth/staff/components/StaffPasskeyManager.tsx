/**
 * 店員のパスキー管理の画面（src/features/auth/staff/components/StaffPasskeyManager.tsx）。一覧・名前の変更・追加・削除。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-385
 * @design DD-AUTH-082
 * @remarks 一覧は窓口（`GET /api/auth/passkey`）の `approved`・`approvedCount` まで読む（`loadStaffPasskeys`）。削除の下限は窓口・DB と同じ数え方で、
 * 認めた鍵を消すと認めた本数が2本未満になるなら、ボタンを無効にして理由を出す。認めていない鍵は常に消せる（疑わしい鍵を外せる）。
 * 最後に決めるのは DB（`passkey_delete_with_floor`）で、窓口が断ったら（409 など）失敗の文を出して一覧を引き直す。
 * 追加は段2の `registerPasskey`。店員の追加は5分以内のパスキーでの入り直しが要るので、`reauth_required` を
 * 「もう一度パスキーでログインしてから追加してください。」と「パスキーでログインし直す」に読み替える。
 * 成功・失敗の知らせは自動では消さない（WCAG 2.2.1）。`challenge_id`・`credential`・トークンは画面にもログにも出さない。
 */
"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { clientFetch } from "@/lib/client-fetch";
import { deletePasskey, registerPasskey, renamePasskey, type RegisterFailureReason } from "@/features/auth/passkey/passkey-client";
import { isPasskeySupported, requestAttestation } from "@/features/auth/passkey/webauthn-browser";
import { deviceNameFromUserAgent } from "@/features/auth/passkey/device-name";
import { isPasskeyNameLengthOk } from "@/features/auth/schemas/passkey";
import { buildLoginHref } from "@/features/auth/return-intent/use-login-href";
import { loadStaffPasskeys, type StaffListedPasskey } from "@/features/auth/staff/staff-passkey-status";
import "@/components/AuthForm.css";

/** 管理の入口に要る認めた鍵の本数（DB の `min_approved_passkeys` の初めの値。窓口・DB と同じ数え方の下限）。 */
const MIN_APPROVED = 2;

const REAUTH_HREF = buildLoginHref("/admin/passkeys", "http://localhost");
const MSG_LOAD_FAILED = "パスキーの一覧を読み込めませんでした。";
const MSG_ADDED = "パスキーを追加しました。";
const MSG_RENAME_FAILED = "名前を変更できませんでした。もう一度お試しください。";
const MSG_NAME_INVALID = "名前は1〜64字（日本語は40字まで）で入力してください。";
const MSG_DELETED = "パスキーを削除しました。";
const MSG_DELETE_FAILED = "削除できませんでした。認めた鍵は2本以上が必要です。";
const MSG_UNSUPPORTED_ADD = "この端末ではパスキーを追加できません。";
const MSG_REAUTH = "もう一度パスキーでログインしてから追加してください。";
const MSG_FLOOR = "認めた鍵が2本のため、削除できません。先にもう1本追加してください。";
const MSG_NOT_APPROVED = "この鍵ではログインできません。心当たりがなければ削除してください。";

function addFailureMessage(reason: RegisterFailureReason): string {
  switch (reason) {
    case "cancelled":
      return "パスキーの作成を中止しました。";
    case "already_registered":
      return "この端末のパスキーは、すでに登録されています。別の端末か、セキュリティキーで登録してください。";
    case "unsupported":
      return "この端末ではパスキーを作れません。";
    case "reauth_required":
      return MSG_REAUTH;
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

const JST_DATE = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" });

/** 日本時間の「YYYY年M月D日」。 */
function formatJstDate(iso: string): string {
  const parts = JST_DATE.formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${pick("year")}年${pick("month")}月${pick("day")}日`;
}

export default function StaffPasskeyManager() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [passkeys, setPasskeys] = useState<StaffListedPasskey[]>([]);
  const [approvedCount, setApprovedCount] = useState(0);
  const [supported, setSupported] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StaffListedPasskey | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addFailure, setAddFailure] = useState<RegisterFailureReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refocusTarget, setRefocusTarget] = useState<string | null>(null);

  useEffect(() => {
    setSupported(isPasskeySupported());
  }, []);

  const load = useCallback(async () => {
    const result = await loadStaffPasskeys();
    if (result.ok) {
      setPasskeys(result.passkeys);
      setApprovedCount(result.approvedCount);
      setStatus("ready");
    } else {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 行が消えた後・表示に戻った後に、フォーカスが body に落ちたままなら戻す（ほかへ移していたら奪わない）。
  useEffect(() => {
    if (refocusTarget === null) return;
    if (document.activeElement === document.body) document.getElementById(refocusTarget)?.focus();
    setRefocusTarget(null);
  }, [refocusTarget]);

  /** 認めた鍵を消すと認めた本数が下限を割るか（窓口・DB と同じ数え方。認めていない鍵は割らない）。 */
  const breaksFloor = (passkey: StaffListedPasskey) => passkey.approved && approvedCount - 1 < MIN_APPROVED;

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
    setRefocusTarget("staff-passkey-add");
  };

  const startEdit = (passkey: StaffListedPasskey) => {
    setEditingId(passkey.id);
    setDraft(passkey.friendly_name ?? "");
    setRenameError(null);
    setNotice(null);
  };

  const cancelEdit = () => {
    const id = editingId!;
    setEditingId(null);
    setRenameError(null);
    setRefocusTarget(`staff-passkey-rename-${id}`);
  };

  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    const id = editingId!;
    const name = draft.trim();
    if (!isPasskeyNameLengthOk(name)) {
      setRenameError(MSG_NAME_INVALID);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    const result = await renamePasskey(id, name);
    setRenameBusy(false);
    if (result.ok) {
      setPasskeys((current) => current.map((item) => (item.id === id ? { ...item, friendly_name: result.passkey.friendly_name } : item)));
      setEditingId(null);
      setRefocusTarget(`staff-passkey-rename-${id}`);
    } else {
      setRenameError(MSG_RENAME_FAILED);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget!;
    setDeleteTarget(null);
    setNotice(null);
    setDeleteError(null);
    setDeletingId(target.id);
    const result = await deletePasskey(target.id);
    setDeletingId(null);
    if (result.ok) {
      setNotice(MSG_DELETED);
      setRefocusTarget("staff-passkey-heading");
    } else {
      setDeleteError(MSG_DELETE_FAILED);
      setRefocusTarget(`staff-passkey-delete-${target.id}`);
    }
    // 成否にかかわらず数え直す（断られた時は、本数が画面と食い違っている）。
    await load();
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      <div className="space-y-6">
        <h1 id="staff-passkey-heading" tabIndex={-1} className="outline-none" style={{ fontSize: "var(--lk-size-3xl)" }}>
          パスキー
        </h1>
        <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-md)" }}>
          顔認証・指紋・PIN で入る方法です。管理画面に入るには、認めた鍵が2本以上必要です。
        </p>

        {status === "loading" ? (
          <div className="animate-pulse" aria-hidden="true" data-testid="staff-passkeys-loading">
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

        {status === "ready" && passkeys.length > 0 ? (
          <ul className="flex flex-col gap-4">
            {passkeys.map((passkey) => {
              const label = passkey.friendly_name ?? "名前なし";
              const blocked = breaksFloor(passkey);
              return (
                <li key={passkey.id} className="border-t border-black/10 pt-4 flex flex-col gap-3 min-w-0">
                  {editingId === passkey.id ? (
                    <form onSubmit={(event) => void saveName(event)} className="flex flex-col gap-3">
                      <label htmlFor={`staff-passkey-name-${passkey.id}`} className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                        名前
                      </label>
                      <input
                        id={`staff-passkey-name-${passkey.id}`}
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
                          {label}
                        </p>
                        <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                          {formatJstDate(passkey.created_at)} に作成
                        </p>
                        {passkey.last_used_at ? (
                          <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                            最後に使った日: {formatJstDate(passkey.last_used_at)}
                          </p>
                        ) : null}
                        {!passkey.approved ? (
                          <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                            {MSG_NOT_APPROVED}
                          </p>
                        ) : null}
                        {blocked ? (
                          <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                            {MSG_FLOOR}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          id={`staff-passkey-rename-${passkey.id}`}
                          aria-label={`${label}の名前を変更`}
                          onClick={() => startEdit(passkey)}
                        >
                          名前を変更
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          id={`staff-passkey-delete-${passkey.id}`}
                          disabled={blocked || deletingId === passkey.id}
                          aria-busy={deletingId === passkey.id}
                          aria-label={`${label}を削除`}
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
              );
            })}
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
            {addFailure === "unauthorized" ? (
              <Button href="/login" variant="primary" size="md">
                ログインへ
              </Button>
            ) : null}
            {addFailure === "reauth_required" ? (
              <Button href={REAUTH_HREF} variant="primary" size="md">
                パスキーでログインし直す
              </Button>
            ) : null}
            <Button
              type="button"
              id="staff-passkey-add"
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
        description="削除すると、このパスキーではログインできなくなります。"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
