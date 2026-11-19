/**
 * パスキーの名前の変更・削除（src/app/api/auth/passkey/[id]/route.ts）。ログインした本人の鍵だけを扱う（お客さんの削除と全員の名前の変更は GoTrue、店員の削除は DB の関数）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-290
 * @design DD-AUTH-057
 * @remarks 順番: 回数の制限（IP ごと 60回／600秒）→ 認証 → CSRF → `id` が uuid でなければ 400（GoTrue を呼ばない）→（PATCH）本文の形 400 →
 * （DELETE の店員）GoTrue を呼ばず、DB の関数 `passkey_delete_with_floor`（下限は DB の中。`staff-passkey-delete`）だけで消す。認めた鍵を下限未満にする削除は 409 `staff_min_keys`、DB が読めなければ 503
 * （DELETE のお客さん・全員の PATCH）GoTrue。店員かの確かめ（`isStaff`）は DELETE だけ。
 * GoTrue へ回す道（お客さんの DELETE・全員の PATCH）は、他人の鍵・存在しない鍵を GoTrue の 404 から 404 `not_found` にそろえる（区別しない）。店員の DELETE の 404 `not_found` は DB の関数の `PASSKEY_NOT_FOUND`。鍵が消えると 1a の引き金が認めの行を消す（アプリは何もしない）。
 */
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { deletePasskey, updatePasskey } from '@/lib/auth/passkey-gotrue';
import { isStaff } from '@/lib/auth/passkey-approval-rpc';
import { deleteStaffPasskey } from '@/lib/auth/staff-passkey-delete';
import { guardPasskeyManage, manageDeny, manageJson } from '@/lib/auth/passkey-manage-guard';
import { PasskeyRenameSchema } from '@/features/auth/schemas/passkey';

/** uuid の形を確かめ、小文字にそろえる（認めた鍵の一覧は小文字。大文字の `id` で下限の確かめをすり抜けさせない）。以降はこの値だけを使う。 */
const IdSchema = z.uuid().transform((value) => value.toLowerCase());

type RouteContext = { params: Promise<{ id: string }> };

/** GoTrue の失敗を窓口の応答に直す。404 は他人の鍵と存在しない鍵を区別しない。 */
function mapGoTrueFailure(status: number): { status: number; body: { error: string }; detail: string } {
  if (status === 404) return { status: 404, body: { error: 'not_found' }, detail: 'not_found' };
  if (status === 401) return { status: 401, body: { error: 'Unauthorized' }, detail: 'gotrue_unauthorized' };
  if (status === 400 || status === 422) return { status: 400, body: { error: 'invalid_request' }, detail: 'gotrue_rejected' };
  return { status: 502, body: { error: 'passkey_manage_failed' }, detail: 'gotrue_failed' };
}

/**
 * 名前の変更。本文は `{ friendly_name }`（1〜64字かつ UTF-8 で120バイト以内・前後の空白を除く・制御文字なし）。
 *
 * @impl IMPL-AUTH-290
 * @design DD-AUTH-057
 */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const auditAction = 'auth.passkey.rename';
  try {
    const guard = await guardPasskeyManage(request, { endpoint: 'auth:passkey:rename', csrf: true });
    if (!guard.ok) return guard.response;
    const { userId, accessToken } = guard;

    const id = IdSchema.safeParse((await context.params).id);
    if (!id.success) return await manageDeny(auditAction, 'invalid_request', userId, { error: 'invalid_request' }, 400);

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return await manageDeny(auditAction, 'invalid_request', userId, { error: 'invalid_request' }, 400);
    }
    const parsed = PasskeyRenameSchema.safeParse(raw);
    if (!parsed.success) return await manageDeny(auditAction, 'invalid_request', userId, { error: 'invalid_request' }, 400);

    const result = await updatePasskey(accessToken, { passkeyId: id.data, friendlyName: parsed.data.friendly_name });
    if (!result.ok) {
      const mapped = mapGoTrueFailure(result.status);
      return await manageDeny(auditAction, mapped.detail, userId, mapped.body, mapped.status);
    }
    const data = result.data as unknown;
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    if (!body || typeof body.id !== 'string' || typeof body.friendly_name !== 'string') {
      return await manageDeny(auditAction, 'gotrue_bad_response', userId, { error: 'passkey_manage_failed' }, 502);
    }

    await logAudit({ action: auditAction, outcome: 'success', detail: 'rename', actor_id: userId });
    return manageJson({ passkey: { id: body.id, friendly_name: body.friendly_name } }, 200);
  } catch {
    console.error('passkey rename handler error');
    await logAudit({ action: auditAction, outcome: 'error', detail: 'unexpected_error' });
    return manageJson({ error: 'Internal server error' }, 500);
  }
}

/**
 * 削除。店員は DB の関数（下限つき）で消し、認めた鍵を下限未満にする削除は 409 `staff_min_keys` で止める。お客さんは最後の1本も消せる。
 *
 * @impl IMPL-AUTH-291
 * @design DD-AUTH-057
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const auditAction = 'auth.passkey.delete';
  try {
    const guard = await guardPasskeyManage(request, { endpoint: 'auth:passkey:delete', csrf: true });
    if (!guard.ok) return guard.response;
    const { userId, accessToken } = guard;

    const id = IdSchema.safeParse((await context.params).id);
    if (!id.success) return await manageDeny(auditAction, 'invalid_request', userId, { error: 'invalid_request' }, 400);

    const staff = await isStaff(userId);
    if (!staff.ok) {
      return await manageDeny(auditAction, 'staff_check_unavailable', userId, { error: 'passkey_manage_unavailable' }, 503);
    }
    if (staff.value) {
      // 店員の削除は DB の関数だけを通す（数えと削除が同じ取引。GoTrue の削除へは落とさない）。ユーザーは検証済みのセッションの人。
      const deleted = await deleteStaffPasskey(userId, id.data);
      if (deleted.ok) {
        await logAudit({ action: auditAction, outcome: 'success', detail: 'delete', actor_id: userId });
        return manageJson({ ok: true }, 200);
      }
      if (deleted.reason === 'min_keys') return await manageDeny(auditAction, 'staff_min_keys', userId, { error: 'staff_min_keys' }, 409);
      if (deleted.reason === 'not_found') return await manageDeny(auditAction, 'not_found', userId, { error: 'not_found' }, 404);
      return await manageDeny(auditAction, 'staff_delete_unavailable', userId, { error: 'passkey_manage_unavailable' }, 503);
    }

    const result = await deletePasskey(accessToken, id.data);
    if (!result.ok) {
      const mapped = mapGoTrueFailure(result.status);
      return await manageDeny(auditAction, mapped.detail, userId, mapped.body, mapped.status);
    }

    await logAudit({ action: auditAction, outcome: 'success', detail: 'delete', actor_id: userId });
    return manageJson({ ok: true }, 200);
  } catch {
    console.error('passkey delete handler error');
    await logAudit({ action: auditAction, outcome: 'error', detail: 'unexpected_error' });
    return manageJson({ error: 'Internal server error' }, 500);
  }
}
