/**
 * 「店員を招待」のボタンと、メール・役割を入れるダイアログ（管理画面「ユーザー」）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-393
 * @design DD-AUTH-084
 * @remarks 送るのは `POST /api/admin/staff/invites`。送信中は送るボタンを `disabled`・`aria-busy` にして二重に送らせない。失敗は `LiveMessage` に出し、ダイアログは閉じない。
 */
"use client";

import React from "react";
import { Button } from "@/components/ui/Button/Button";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { TextField } from "@/components/ui/TextField/TextField";
import { postStaffAction } from "@/features/auth/staff/staff-user-actions";

type InviteStaffDialogProps = {
  /** 招待を送れた時。親が一覧を読み直し、知らせを出す。 */
  onInvited: (email: string) => void;
};

export default function InviteStaffDialog({ onInvited }: InviteStaffDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"admin" | "supporter">("supporter");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (busy || trimmed === "") return;
    setBusy(true);
    setError(null);
    const result = await postStaffAction("/api/admin/staff/invites", { email: trimmed, role });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    setEmail("");
    onInvited(trimmed);
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} className="font-acumin">
        店員を招待
      </Button>
      <Dialog open={open} onClose={close} title="店員を招待">
        <form className="space-y-3" onSubmit={submit}>
          <p className="font-acumin lk-text-3xs text-[#474747]">
            招待のメールを送ります。相手はリンクから、顔認証・指紋・PIN で入る方法（パスキー）を2本登録します。
          </p>
          <TextField
            label="メールアドレス"
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <div>
            <label htmlFor="invite-staff-role" className="font-acumin lk-text-3xs text-[#474747]">
              役割
            </label>
            <select
              id="invite-staff-role"
              className="mt-1 w-full border border-black/20 bg-white px-2 py-2 font-acumin lk-text-sm"
              value={role}
              onChange={(event) => setRole(event.target.value as "admin" | "supporter")}
            >
              <option value="supporter">サポーター</option>
              <option value="admin">店長</option>
            </select>
          </div>
          <LiveMessage className="lk-text-sm text-red-700 font-acumin">{error}</LiveMessage>
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={close} disabled={busy}>
              戻る
            </Button>
            <Button
              type="submit"
              size="sm"
              className="w-full font-acumin"
              disabled={busy || email.trim() === ""}
              aria-busy={busy}
            >
              招待を送る
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
