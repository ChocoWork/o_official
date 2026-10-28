import { logAudit } from '@/lib/audit';
import { getAuditRequestContext } from '@/lib/request-ip';

/**
 * 管理の LOOK の操作を、成功も失敗も同じ形で監査に残す。
 *
 * @impl IMPL-LOOK-143
 * @design DD-LOOK-065
 * @remarks 誰がいつ何をしたかを後から追えるよう、窓口ごとに書き方がずれないよう resource を look に固定して1か所で書く（ARC-LOOK-002）。
 * 送り元の IP とブラウザの名乗りは getAuditRequestContext から取る。IP は信頼する見出しだけから取り、取れない配置では null のまま保存する（x-forwarded-for は読まない。SEC-LOOK-020、ADR-0462）。
 * 監査の列は文字か null なので、無い値は null にそろえる。
 */
export async function logAdminLookAudit(input: {
  request: Request;
  actorId: string;
  actorEmail: string | null;
  action: string;
  outcome: 'success' | 'failure';
  detail: string;
  resourceId?: string | number | null;
  metadata?: Record<string, unknown>;
}) {
  return logAudit({
    action: input.action,
    actor_id: input.actorId,
    actor_email: input.actorEmail,
    resource: 'look',
    resource_id:
      input.resourceId === undefined || input.resourceId === null
        ? null
        : String(input.resourceId),
    outcome: input.outcome,
    detail: input.detail,
    ...getAuditRequestContext(input.request),
    metadata: input.metadata ?? null,
  });
}