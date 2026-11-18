"use client";

import React from "react";
import { clientFetch } from "@/lib/client-fetch";
import { DataTable } from "@/components/ui/DataTable/DataTable";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { StatusBadge } from "@/components/ui/StatusBadge/StatusBadge";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import InviteStaffDialog from "@/features/auth/staff/components/InviteStaffDialog";
import StaffRoleActions from "@/features/auth/staff/components/StaffRoleActions";
import {
  STAFF_MSG_ALREADY_STAFF,
  STAFF_MSG_MAIL_FAILED,
  STAFF_MSG_UNAVAILABLE,
} from "@/features/auth/staff/staff-user-actions";

type UserRoleValue = "admin" | "supporter" | "user";
type UserRoleLabel = "Admin" | "Support" | "User";
type UserStatus = "アクティブ" | "非アクティブ";

type UserItem = {
  id: string;
  name: string;
  email: string;
  role: UserRoleLabel;
  roleValue: UserRoleValue;
  lastLogin: string;
  status: UserStatus;
  approvedPasskeys?: number;
  invitePending?: boolean;
};

const roleLabelMap: Record<UserRoleValue, UserRoleLabel> = {
  admin: "Admin",
  supporter: "Support",
  user: "User",
};

const roleOrderMap: Record<UserRoleValue, number> = {
  admin: 0,
  supporter: 1,
  user: 2,
};

const roleSelectClassMap: Record<UserRoleValue, string> = {
  admin: "bg-black text-white border-black",
  supporter: "bg-gray-300 text-black border-gray-400",
  user: "bg-white text-black border-black/20",
};

const statusClassMap: Record<UserStatus, string> = {
  アクティブ: "bg-green-100 text-green-800 border-none",
  非アクティブ: "bg-gray-100 text-gray-500 border-none",
};

export default function UserSection() {
  const [users, setUsers] = React.useState<UserItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [savingUserId, setSavingUserId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [selfId, setSelfId] = React.useState<string | null>(null);
  const [promotion, setPromotion] = React.useState<{
    user: UserItem;
    role: UserRoleValue;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await clientFetch("/api/auth/me", { cache: "no-store" });
        const body: unknown = response.ok ? await response.json() : null;
        const id =
          typeof body === "object" && body !== null && "user" in body
            ? (body as { user?: { id?: unknown } }).user?.id
            : undefined;
        if (!cancelled && typeof id === "string") setSelfId(id);
      } catch {
        // 自分の行を見分けられなくても、窓口が自分への操作を断る
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchUsers = React.useCallback(async (silent = false) => {
    try {
      if (!silent) setIsLoading(true);
      setErrorMessage(null);

      const response = await clientFetch("/api/admin/users", {
        cache: "no-store",
      });
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("認証が必要です。再ログインしてください。");
        }

        if (response.status === 403) {
          throw new Error("この操作を実行する権限がありません。");
        }

        throw new Error("ユーザー一覧の取得に失敗しました。");
      }

      const json = (await response.json()) as { data: UserItem[] };
      setUsers(json.data ?? []);
    } catch (error) {
      console.error("Failed to load admin users:", error);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "ユーザー一覧の取得に失敗しました。",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const sortedUsers = React.useMemo(() => {
    return [...users].sort((a, b) => {
      const roleOrderDiff =
        roleOrderMap[a.roleValue] - roleOrderMap[b.roleValue];
      if (roleOrderDiff !== 0) {
        return roleOrderDiff;
      }

      return a.name.localeCompare(b.name, "ja");
    });
  }, [users]);

  const lastAdminId = React.useMemo(() => {
    const admins = users.filter((user) => user.roleValue === "admin");
    return admins.length === 1 ? admins[0].id : null;
  }, [users]);

  const handleRoleChange = async (
    userId: string,
    nextRole: UserRoleValue,
    invite = false,
  ) => {
    const previousUsers = users;
    setNotice(null);

    // お客さんを店員にする時は、役割をすぐには変えない（招待のメールを送るだけ）
    if (!invite) {
      setUsers((currentUsers) =>
        currentUsers.map((user) =>
          user.id === userId
            ? {
                ...user,
                roleValue: nextRole,
                role: roleLabelMap[nextRole],
              }
            : user,
        ),
      );
    }

    setSavingUserId(userId);

    try {
      const response = await clientFetch("/api/admin/users", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId, role: nextRole }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code =
          typeof body === "object" && body !== null && "code" in body
            ? body.code
            : undefined;
        if (response.status === 502 || code === "mail_failed") {
          throw new Error(STAFF_MSG_MAIL_FAILED);
        }
        if (code === "already_staff") {
          throw new Error(STAFF_MSG_ALREADY_STAFF);
        }
        if (response.status === 503 || response.status === 429) {
          throw new Error(STAFF_MSG_UNAVAILABLE);
        }
        if (typeof body === "object" && body !== null && "code" in body) {
          if (body.code === "LAST_ADMIN_REQUIRED") {
            throw new Error("店長を1人以上残してください。");
          }
          if (body.code === "SELF_ROLE_CHANGE_FORBIDDEN") {
            throw new Error("自分自身の役割は変更できません。");
          }
        }

        if (response.status === 403) {
          throw new Error("権限変更は管理者のみ実行できます。");
        }

        if (response.status === 401) {
          throw new Error("認証が必要です。再ログインしてください。");
        }

        throw new Error("権限の更新に失敗しました。");
      }
      if (invite) {
        setNotice("招待のメールを送りました。");
        await fetchUsers(true);
      }
    } catch (error) {
      console.error("Failed to update role:", error);
      setUsers(previousUsers);
      setErrorMessage(
        error instanceof Error ? error.message : "権限の更新に失敗しました。",
      );
    } finally {
      setSavingUserId(null);
    }
  };

  const handleStaffDone = (message: string) => {
    setErrorMessage(null);
    setNotice(message);
    void fetchUsers(true);
  };

  if (isLoading) {
    return (
      <section>
        <p className="lk-text-sm text-[#474747] font-acumin">
          ユーザー一覧を読み込み中です...
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-4 flex justify-end">
        <InviteStaffDialog
          onInvited={(email) =>
            handleStaffDone(`${email} へ、招待のメールを送りました。`)
          }
        />
      </div>
      <LiveMessage className="mb-4 lk-text-sm text-red-700 font-acumin">
        {errorMessage}
      </LiveMessage>
      <LiveMessage
        politeness="status"
        className="mb-4 lk-text-sm text-[#474747] font-acumin"
      >
        {notice}
      </LiveMessage>

      <DataTable
        rows={sortedUsers}
        rowKey={(user) => user.id}
        columns={[
          {
            key: "name",
            header: "名前",
            render: (user) => <p className="font-acumin">{user.name}</p>,
          },
          {
            key: "email",
            header: "メールアドレス",
            render: (user) => (
              <p className="text-[#474747] font-acumin">{user.email}</p>
            ),
          },
          {
            key: "role",
            header: "権限",
            className: "w-45",
            render: (user) => (
              <SingleSelect
                variant="dropdown"
                className={`w-35 tracking-widest font-acumin ${roleSelectClassMap[user.roleValue]}`}
                value={user.roleValue}
                onValueChange={(value) => {
                  if (user.roleValue === "user" && value !== "user") {
                    // 店員にする: 招待のメールを送ると確認してから送る
                    setPromotion({ user, role: value as UserRoleValue });
                    return;
                  }
                  void handleRoleChange(user.id, value as UserRoleValue);
                }}
                disabled={
                  savingUserId === user.id ||
                  user.id === selfId ||
                  user.id === lastAdminId
                }
                // 店員の行から選択欄で User にすると確認なしで降格してしまうので、選ばせない（「お客さんに戻す」の確認つきボタンだけにする）
                options={[
                  { value: "admin", label: "Admin" },
                  { value: "supporter", label: "Support" },
                  ...(user.roleValue === "user"
                    ? [{ value: "user", label: "User" }]
                    : []),
                ]}
                size="sm"
              />
            ),
          },
          {
            key: "staff",
            header: "店員の操作",
            render: (user) => (
              <StaffRoleActions
                user={user}
                isSelf={user.id === selfId}
                isLastAdmin={user.id === lastAdminId}
                onDone={handleStaffDone}
                onError={setErrorMessage}
              />
            ),
          },
          {
            key: "lastLogin",
            header: "最終ログイン",
            render: (user) => (
              <p className="text-[#474747] font-acumin">{user.lastLogin}</p>
            ),
          },
          {
            key: "status",
            header: "ステータス",
            render: (user) => (
              <StatusBadge className={statusClassMap[user.status]} size="md">
                {user.status}
              </StatusBadge>
            ),
          },
        ]}
        size="md"
      />

      <ConfirmDialog
        open={promotion !== null}
        title="店員にする"
        description={
          promotion
            ? `${promotion.user.email} へ、招待のメールを送ります。相手がパスキーを登録するまで、役割は変わりません。`
            : undefined
        }
        confirmLabel="店員にする"
        onCancel={() => setPromotion(null)}
        onConfirm={() => {
          const target = promotion;
          setPromotion(null);
          if (target) void handleRoleChange(target.user.id, target.role, true);
        }}
      />
    </section>
  );
}
