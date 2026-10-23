'use client';

// File: src/components/RolePermissionsSection.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SwitchToggle } from '@/components/ui/SwitchToggle/SwitchToggle';
import type { PermissionCode } from '@/lib/auth/admin-rbac';
import { ROLE_PERMISSION_CATALOG, getMissingPermissionDependencies } from '@/lib/auth/role-permission-catalog';
import type {
  PermissionDefinition, PermissionRoleState, PermissionsMatrix, RolePermissionChange, RolePermissionChangeResult,
} from '@/lib/auth/role-permission-types';
import { clientFetch } from '@/lib/client-fetch';

const LOAD_FAILED = '権限を読み込めませんでした。';
const RESULT_UNKNOWN = '保存結果を確認できませんでした。同じ変更を再送するか、現在の設定を読み直してください。';
const codeMessages = new Map<string, string>([
  ['ROLE_PERMISSION_FORBIDDEN', '権限を変更する権限がありません。'],
  ['ROLE_PERMISSION_FIXED', '権限管理と利用者管理は店長のみ・変更不可です。'],
  ['LAST_ADMIN_REQUIRED', '店長を1人以上残してください。'],
  ['SELF_ROLE_CHANGE_FORBIDDEN', '自分自身の役割は変更できません。'],
  ['ROLE_PERMISSION_ARGUMENT_INVALID', '入力を確かめてください。'],
  ['ROLE_PERMISSION_VERSION_CONFLICT', 'ほかの人が権限を変更しました。現在の設定を読み直してください。'],
  ['ROLE_PERMISSION_REQUEST_KEY_CONFLICT', '同じ要求番号で異なる変更は保存できません。現在の設定を読み直してください。'],
]);
const reasonMessages = new Map<string, string>([
  ['MFA required', '2要素認証が必要です'],
  ['CSRF validation failed', '安全確認に失敗しました。ページを開き直してください。'],
]);

type Failure = { message: string; recovery: 'resend' | 'reload' | null };
type Confirmation = { role: PermissionRoleState; permission: PermissionDefinition; next: boolean };

/** GET/POSTの双方で、既知code、既知reason、statusの順を守る。生のerrorは読まない。 */
function failureFor(status: number, body: unknown, operation: 'load' | 'save'): Failure {
  const parsed = z.object({ code: z.unknown().optional(), reason: z.unknown().optional() }).safeParse(body);
  const code = parsed.success && typeof parsed.data.code === 'string' ? parsed.data.code : undefined;
  const reason = parsed.success && typeof parsed.data.reason === 'string' ? parsed.data.reason : undefined;
  const message = code === undefined ? undefined : codeMessages.get(code);
  if (message !== undefined) {
    return { message, recovery: code === 'ROLE_PERMISSION_VERSION_CONFLICT' || code === 'ROLE_PERMISSION_REQUEST_KEY_CONFLICT' ? 'reload' : null };
  }
  const reasonMessage = reason === undefined ? undefined : reasonMessages.get(reason);
  if (reasonMessage !== undefined) return { message: reasonMessage, recovery: null };
  if (status === 401) return { message: 'ログインし直してください。', recovery: null };
  if (status === 403) return { message: 'アクセス権限がありません', recovery: null };
  if (status === 409) return { message: '変更が競合しました。現在の設定を読み直してください。', recovery: 'reload' };
  if (status === 429) return { message: '操作が多すぎます。しばらく待ってから、もう一度お試しください。', recovery: null };
  if (status >= 400 && status < 500) return { message: '入力を確かめてください。', recovery: null };
  return operation === 'load' ? { message: LOAD_FAILED, recovery: null } : { message: RESULT_UNKNOWN, recovery: 'resend' };
}

const managedCodes = new Set<string>(ROLE_PERMISSION_CATALOG.map((p) => p.code));
const permissionCodeSchema = z.custom<PermissionCode>((value) => typeof value === 'string' && managedCodes.has(value));
const codesSchema = z.array(permissionCodeSchema).max(ROLE_PERMISSION_CATALOG.length)
  .refine((codes) => new Set(codes).size === codes.length);
const roleSchema: z.ZodType<PermissionRoleState> = z.object({
  code: z.enum(['admin', 'supporter']),
  label: z.string(),
  version: z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
    .refine((version) => version.length < 19 || version <= '9223372036854775807'),
  permissionCodes: codesSchema,
});
const matrixSchema = z.object({ data: z.object({
  permissions: z.array(z.object({ code: permissionCodeSchema })).length(ROLE_PERMISSION_CATALOG.length)
    .refine((rows) => new Set(rows.map((p) => p.code)).size === ROLE_PERMISSION_CATALOG.length),
  roles: z.array(roleSchema).length(2).refine((roles) => new Set(roles.map((role) => role.code)).size === 2),
}) });
const resultSchema: z.ZodType<{ data: RolePermissionChangeResult }> = z.object({ data: z.object({
  role: roleSchema, changedCount: z.number().int().min(0).max(ROLE_PERMISSION_CATALOG.length),
}) });

/** 一覧の順序・分野・文言は共有catalog、許可と版は成功したAPI応答だけから得る。 */
export default function RolePermissionsSection(): React.JSX.Element {
  const [matrix, setMatrix] = useState<PermissionsMatrix | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState<RolePermissionChange | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 再読込・アンマウントを越えた遅い応答を採用しない。refは同一描画内の連打も止める。
  const generation = useRef(0);
  const saving = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    saving.current = false;
    setIsSaving(false);
    setIsLoading(true);
    setMatrix(null);
    setConfirmation(null);
    setPending(null);
    setFailure(null);
    setNotice(null);
    try {
      const response = await clientFetch('/api/admin/permissions', { cache: 'no-store' });
      const body: unknown = await response.json().catch(() => null);
      if (current !== generation.current) return;
      if (!response.ok) {
        setFailure(failureFor(response.status, body, 'load'));
      } else {
        const parsed = matrixSchema.safeParse(body);
        if (!parsed.success) setFailure({ message: LOAD_FAILED, recovery: null });
        else setMatrix({ permissions: [...ROLE_PERMISSION_CATALOG], roles: parsed.data.data.roles });
      }
    } catch {
      if (current === generation.current) setFailure({ message: LOAD_FAILED, recovery: null });
    } finally {
      if (current === generation.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const send = async (change: RolePermissionChange): Promise<void> => {
    if (saving.current) return;
    saving.current = true;
    const current = ++generation.current;
    setIsSaving(true);
    setNotice(null);
    try {
      const response = await clientFetch('/api/admin/role-permissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
      });
      const body: unknown = await response.json().catch(() => null);
      if (current !== generation.current) return;
      if (!response.ok) {
        setFailure(failureFor(response.status, body, 'save'));
      } else {
        const parsed = resultSchema.safeParse(body);
        if (!parsed.success || parsed.data.data.role.code !== change.roleCode) {
          setFailure({ message: RESULT_UNKNOWN, recovery: 'resend' });
        } else {
          const { role } = parsed.data.data;
          setMatrix((previous) => previous === null ? null : {
            ...previous, roles: previous.roles.map((entry) => entry.code === role.code ? role : entry),
          });
          setPending(null);
          setFailure(null);
          setNotice('権限を保存しました。');
        }
      }
    } catch {
      if (current === generation.current) setFailure({ message: RESULT_UNKNOWN, recovery: 'resend' });
    } finally {
      if (current === generation.current) {
        saving.current = false;
        setIsSaving(false);
        setConfirmation(null);
      }
    }
  };

  const confirm = (): void => {
    if (confirmation === null || saving.current) return;
    const { role, permission, next } = confirmation;
    const change: RolePermissionChange = {
      roleCode: role.code,
      permissionCodes: next ? [...role.permissionCodes, permission.code] : role.permissionCodes.filter((code) => code !== permission.code),
      expectedVersion: role.version,
      requestKey: crypto.randomUUID(),
    };
    setPending(change);
    void send(change);
  };

  const locked = isLoading || isSaving || failure?.recovery === 'resend' || failure?.recovery === 'reload';
  const areas = [...new Set(matrix?.permissions.map((permission) => permission.area))];
  const close = (): void => { if (!isSaving && !saving.current) setConfirmation(null); };

  return (
    <section className="w-full min-w-0 max-w-full space-y-6">
      <Button href="/admin?tab=SETTINGS" variant="secondary">管理画面に戻る</Button>
      <div className="space-y-2">
        <h1 className="lk-text-xl">権限</h1>
        <p>役割ごとに、できる操作を設定します。</p>
        <p className="lk-text-sm text-[#474747]">管理メニューの表示は、権限の設定ではなく役割名で決まります。</p>
      </div>
      {isLoading ? <p role="status">読み込み中...</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {failure ? (
        <div className="space-y-3">
          <p role="alert">{failure.message}</p>
          <div className="flex flex-wrap gap-3">
            {matrix === null && !isLoading ? <Button onClick={() => void load()}>再読み込み</Button> : null}
            {matrix !== null && failure.recovery === 'resend' && pending ? (
              <Button disabled={isSaving} onClick={() => void send(pending)}>同じ変更を再送</Button>
            ) : null}
            {matrix !== null && failure.recovery !== null ? (
              <Button variant="secondary" onClick={() => void load()}>現在の設定を読み直す</Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {isSaving && confirmation === null ? <p role="status">保存しています...</p> : null}
      {matrix ? (
        <>
          {matrix.roles.map((role) => {
            const missing = getMissingPermissionDependencies(role.permissionCodes);
            return missing.length > 0 ? (
              <section key={role.code} aria-label={`${role.label}の依存不足`} className="space-y-1">
                <h2 className="lk-text-sm">{role.label}</h2>
                <p>操作に必要な権限が不足しています：{missing.map((code) => ROLE_PERMISSION_CATALOG.find((p) => p.code === code)?.label).join('、')}。</p>
              </section>
            ) : null;
          })}
          <h2 id="role-permissions-table-title" className="lk-text-lg">権限の表</h2>
          <div role="region" aria-labelledby="role-permissions-table-title" tabIndex={0} className="max-w-full overflow-x-auto border border-black/15 focus-visible:outline-2">
            <table className="w-full min-w-[52rem] table-fixed border-collapse text-left">
              <thead>
                <tr className="border-b border-black/15">
                  <th scope="col" className="w-3/5 p-3">操作</th>
                  {matrix.roles.map((role) => <th key={role.code} scope="col" className="w-1/5 p-3 text-center">{role.label}</th>)}
                </tr>
              </thead>
              {areas.map((area) => (
                <tbody key={area}>
                  <tr className="bg-black/5"><th scope="rowgroup" colSpan={3} className="p-3">{area}</th></tr>
                  {matrix.permissions.filter((permission) => permission.area === area).map((permission) => (
                    <tr key={permission.code} className="border-b border-black/10">
                      <th scope="row" className="break-words p-3 font-normal">
                        {permission.label}
                        {permission.upcoming ? <p className="mt-1 lk-text-xs text-[#474747]">この権限は、対応する画面の公開後に使われます。</p> : null}
                      </th>
                      {permission.fixed ? <td colSpan={2} className="p-3 text-center">店長のみ・変更不可</td> : matrix.roles.map((role) => (
                        <td key={role.code} className="p-3 text-center">
                          <SwitchToggle
                            checked={role.permissionCodes.includes(permission.code)}
                            ariaLabel={`${role.label}：${permission.label}`}
                            disabled={locked}
                            onChange={(next) => {
                              if (locked || confirmation !== null) return;
                              setFailure(null);
                              setNotice(null);
                              setConfirmation({ role, permission, next });
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </>
      ) : null}
      <Dialog
        open={confirmation !== null}
        title="権限を変更する"
        description={confirmation ? `${confirmation.role.label}の「${confirmation.permission.label}」を${confirmation.next ? '許可' : '解除'}します。変更しますか？` : undefined}
        fullScreenOnMobile
        onClose={close}
      >
        {isSaving ? <p role="status" className="mb-3">保存しています...</p> : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" disabled={isSaving} onClick={close}>戻る</Button>
          <Button disabled={isSaving} onClick={confirm}>変更する</Button>
        </div>
      </Dialog>
    </section>
  );
}
