/**
 * 店員のパスキーを全部消してやり直させるダイアログ（確認の語「やり直し」と理由10〜500字が要る）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-394
 * @design DD-AUTH-090
 * @remarks 送るのは `POST /api/admin/staff/[id]/redo`。語が違う・理由が10字未満（前後の空白を除く）・501字以上のあいだは送れない。送信中は `disabled`・`aria-busy`。失敗は `LiveMessage`。
 */
"use client";

import React from "react";
import { Button } from "@/components/ui/Button/Button";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { TextAreaField } from "@/components/ui/TextAreaField/TextAreaField";
import { TextField } from "@/components/ui/TextField/TextField";
import { postStaffAction } from "@/features/auth/staff/staff-user-actions";

const CONFIRM_WORD = "やり直し";

type RedoStaffDialogProps = {
  user: { id: string; email: string };
  onClose: () => void;
  /** 送れた時。親が一覧を読み直し、知らせを出す。 */
  onDone: (email: string) => void;
  /** 発行は済み、メールだけが送れなかった時。親がダイアログを閉じ、一覧を読み直して文を出す。 */
  onMailFailed: (message: string) => void;
};

export default function RedoStaffDialog({ user, onClose, onDone, onMailFailed }: RedoStaffDialogProps) {
  const [confirm, setConfirm] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reasonLength = reason.trim().length;
  const canSubmit = confirm === CONFIRM_WORD && reasonLength >= 10 && reasonLength <= 500;

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await postStaffAction(`/api/admin/staff/${user.id}/redo`, { confirm, reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      if (result.mailFailed) {
        onMailFailed(result.message);
        return;
      }
      setError(result.message);
      return;
    }
    onDone(user.email);
  };

  return (
    <Dialog open onClose={close} title="パスキーを全部消してやり直す">
      <form className="space-y-3" onSubmit={submit}>
        <p className="font-acumin lk-text-3xs text-[#474747]">
          {user.email} のパスキーをすべて削除し、ログインを終わらせます。登録のやり直しの招待を、メールで送ります。取り消せません。
        </p>
        <TextField
          label={`確認のため「${CONFIRM_WORD}」と入力`}
          autoComplete="off"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <TextAreaField
          label="理由（10字以上）"
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <LiveMessage className="lk-text-sm text-red-700 font-acumin">{error}</LiveMessage>
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={close} disabled={busy}>
            戻る
          </Button>
          <Button type="submit" size="sm" className="w-full font-acumin" disabled={busy || !canSubmit} aria-busy={busy}>
            やり直しを送る
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
