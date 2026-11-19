/**
 * 「ユーザー」の1行の店員の操作（認めた鍵の本数・やり直し・お客さんに戻す・招待中と取り消し）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-395
 * @design DD-AUTH-084
 * @remarks 店員の行: 認めた鍵の本数、「パスキーを全部消してやり直す」、「お客さんに戻す」（確認を挟む）。自分の行と最後の店長の行は押せず、理由を文で出す。
 * 役割が無く開いた招待がある人の行: 「招待中」と「招待を取り消す」。それ以外のお客さんの行は何も出さない（役割の選択は親が持つ）。
 */
"use client";

import React from "react";
import { Button } from "@/components/ui/Button/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import RedoStaffDialog from "@/features/auth/staff/components/RedoStaffDialog";
import { postStaffAction, STAFF_MSG_LAST_ADMIN, STAFF_MSG_SELF } from "@/features/auth/staff/staff-user-actions";

export type StaffRowUser = {
  id: string;
  email: string;
  roleValue: "admin" | "supporter" | "user";
  approvedPasskeys?: number;
  invitePending?: boolean;
};

type StaffRoleActionsProps = {
  user: StaffRowUser;
  isSelf: boolean;
  isLastAdmin: boolean;
  /** 送った操作が済んだ時。親が一覧を読み直し、知らせを出す（`null` は知らせなしで読み直すだけ）。 */
  onDone: (message: string | null) => void;
  onError: (message: string) => void;
};

export default function StaffRoleActions({ user, isSelf, isLastAdmin, onDone, onError }: StaffRoleActionsProps) {
  const [redoOpen, setRedoOpen] = React.useState(false);
  const [demoteOpen, setDemoteOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const run = async (url: string, doneMessage: string) => {
    if (busy) return;
    setBusy(true);
    const result = await postStaffAction(url);
    setBusy(false);
    // 取り消す物が無かった時（すでに取り消し済み）は、嘘の「取り消しました」を出さず、一覧だけ読み直す。
    if (result.ok) onDone(result.cancelled === false ? null : doneMessage);
    else onError(result.message);
  };

  if (user.roleValue === "user") {
    if (!user.invitePending) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-acumin lk-text-sm text-[#474747]">招待中</span>
        <Button
          size="sm"
          variant="secondary"
          className="font-acumin"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void run(`/api/admin/staff/${user.id}/invite/cancel`, `${user.email} への招待を取り消しました。`)}
        >
          招待を取り消す
        </Button>
      </div>
    );
  }

  const blocked = isSelf || isLastAdmin;
  const blockedNote = isSelf ? STAFF_MSG_SELF : isLastAdmin ? STAFF_MSG_LAST_ADMIN : null;
  const noteId = `staff-actions-note-${user.id}`;

  return (
    <div className="space-y-1">
      <p className="font-acumin lk-text-sm text-[#474747]">認めた鍵 {user.approvedPasskeys ?? 0}本</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="font-acumin"
          disabled={blocked || busy}
          aria-describedby={blockedNote ? noteId : undefined}
          onClick={() => setRedoOpen(true)}
        >
          パスキーを全部消してやり直す
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="font-acumin"
          disabled={blocked || busy}
          aria-busy={busy}
          aria-describedby={blockedNote ? noteId : undefined}
          onClick={() => setDemoteOpen(true)}
        >
          お客さんに戻す
        </Button>
      </div>
      {blockedNote ? (
        <p id={noteId} className="font-acumin lk-text-3xs text-[#474747]">
          {blockedNote}
        </p>
      ) : null}
      {redoOpen ? (
        <RedoStaffDialog
          user={user}
          onClose={() => setRedoOpen(false)}
          onDone={(email) => {
            setRedoOpen(false);
            onDone(`${email} へ、やり直しの招待のメールを送りました。`);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={demoteOpen}
        title="お客さんに戻す"
        description={`${user.email} の店員の役割を外し、ログインを終わらせます。`}
        confirmLabel="お客さんに戻す"
        onCancel={() => setDemoteOpen(false)}
        onConfirm={() => {
          setDemoteOpen(false);
          void run(`/api/admin/staff/${user.id}/demote`, `${user.email} をお客さんに戻しました。`);
        }}
      />
    </div>
  );
}
