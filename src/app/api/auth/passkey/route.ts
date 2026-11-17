/**
 * パスキーの一覧（src/app/api/auth/passkey/route.ts）。ログインした本人の鍵を GoTrue から取り、許可リスト方式で写して返す。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-278
 * @design DD-AUTH-057
 * @remarks 順番: 回数の制限（IP ごと 60回／600秒）→ 認証 → 店員かの確かめ（503）→ GoTrue（502）→ 店員だけ認めた鍵の一覧と本数（503）→ 200。
 * 項目は `id`・`friendly_name`・`created_at`・`last_used_at` だけを写す（GoTrue が公開鍵・`credential_id` を返しても出さない）。
 * `approved`・`approvedCount` は店員だけ。形の違う応答は 502（閉じる側）。
 */
import { logAudit } from '@/lib/audit';
import { listPasskeys } from '@/lib/auth/passkey-gotrue';
import { approvedCount, approvedIds, isStaff } from '@/lib/auth/passkey-approval-rpc';
import { guardPasskeyManage, manageDeny, manageJson } from '@/lib/auth/passkey-manage-guard';

const AUDIT_ACTION = 'auth.passkey.list';

type Item = { id: string; friendly_name: string | null; created_at: string; last_used_at: string | null };

function readItems(data: unknown): Item[] | null {
  if (!Array.isArray(data)) return null;
  const items: Item[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') return null;
    const { id, friendly_name, created_at, last_used_at } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || typeof created_at !== 'string') return null;
    items.push({
      id,
      friendly_name: typeof friendly_name === 'string' ? friendly_name : null,
      created_at,
      last_used_at: typeof last_used_at === 'string' ? last_used_at : null,
    });
  }
  return items;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const guard = await guardPasskeyManage(request, { endpoint: 'auth:passkey:list', csrf: false });
    if (!guard.ok) return guard.response;
    const { userId, accessToken } = guard;

    const staff = await isStaff(userId);
    if (!staff.ok) {
      return await manageDeny(AUDIT_ACTION, 'staff_check_unavailable', userId, { error: 'passkey_manage_unavailable' }, 503);
    }

    const listed = await listPasskeys(accessToken);
    if (!listed.ok) {
      if (listed.status === 401) return await manageDeny(AUDIT_ACTION, 'gotrue_unauthorized', userId, { error: 'Unauthorized' }, 401);
      return await manageDeny(AUDIT_ACTION, 'gotrue_failed', userId, { error: 'passkey_list_failed' }, 502);
    }
    const items = readItems(listed.data);
    if (!items) return await manageDeny(AUDIT_ACTION, 'gotrue_bad_response', userId, { error: 'passkey_list_failed' }, 502);

    if (!staff.value) {
      await logAudit({ action: AUDIT_ACTION, outcome: 'success', detail: 'list', actor_id: userId });
      return manageJson({ passkeys: items, isStaff: false }, 200);
    }

    const [ids, count] = await Promise.all([approvedIds(userId), approvedCount(userId)]);
    if (!ids.ok || !count.ok) {
      return await manageDeny(AUDIT_ACTION, 'approval_check_unavailable', userId, { error: 'passkey_manage_unavailable' }, 503);
    }
    const approved = new Set(ids.value);
    await logAudit({ action: AUDIT_ACTION, outcome: 'success', detail: 'list', actor_id: userId });
    return manageJson(
      {
        passkeys: items.map((item) => ({ ...item, approved: approved.has(item.id) })),
        isStaff: true,
        approvedCount: count.value,
      },
      200,
    );
  } catch {
    console.error('passkey list handler error');
    await logAudit({ action: AUDIT_ACTION, outcome: 'error', detail: 'unexpected_error' });
    return manageJson({ error: 'Internal server error' }, 500);
  }
}
