/**
 * 認可で断った管理の要求を監査に残す共有の部品（src/lib/auth/audit-authz-denial.ts）。
 *
 * @packageDocumentation
 */
import { incrementCounter } from '@/features/auth/ratelimit';
import { logAudit } from '@/lib/audit';
import type { AuthzFailure } from '@/lib/auth/admin-rbac';
import { describeErrorForLog } from '@/lib/logging/safe-error';
import { getAuditRequestContext } from '@/lib/request-ip';

/** 同じ操作者の断った要求の監査を、600 秒の区切りごとに書く行数の上限 */
export const AUTHZ_DENIAL_AUDIT_LIMIT = 20;

const AUTHZ_DENIAL_AUDIT_ENDPOINT = 'admin_authz_denial_audit';
const AUTHZ_DENIAL_AUDIT_WINDOW_SECONDS = 600;

/**
 * 操作者が分かる拒否（失効した session の 401・権限不足と aal1 の 403）を監査に 1 行残す。
 * 同じ操作者は 10 分に 20 行まで、21 回目は `denied_burst` のまとめの 1 行、それ以降と数えの失敗は何も書かない。
 * `denial` が無い拒否（token 無しの 401・503・500）は何もしない。投げない。
 *
 * @impl IMPL-STOCKIST-150
 * @design DD-STOCKIST-039
 * @remarks 上限を全体でなく操作者ごとに数えるのは、全体の上限だと、ある操作者が自分で 20 回断られるだけで
 * 他の人の拒否の記録が 10 分消え、攻撃者が自分の拒否で他人の跡を消せるため。数えに失敗した時に書かないのは、
 * 監査の補助で窓口の応答を変えないため（閉じる側でなく、記録を諦める側に倒す）。
 */
export async function auditAuthzDenial(
  authz: AuthzFailure,
  input: { request: Request; action: string; resource: string },
): Promise<void> {
  try {
    const { denial } = authz;
    if (!denial) return;

    const windowMs = AUTHZ_DENIAL_AUDIT_WINDOW_SECONDS * 1000;
    const bucket = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
    const count = await incrementCounter({ endpoint: AUTHZ_DENIAL_AUDIT_ENDPOINT, bucket, subject: denial.userId });

    if (count > AUTHZ_DENIAL_AUDIT_LIMIT + 1) return;

    const base = {
      action: input.action,
      actor_id: denial.userId,
      actor_email: denial.email,
      resource: input.resource,
      ...getAuditRequestContext(input.request),
    };

    if (count === AUTHZ_DENIAL_AUDIT_LIMIT + 1) {
      await logAudit({
        ...base,
        outcome: 'denied_burst',
        detail: 'further denials suppressed for this window',
      });
      return;
    }

    await logAudit({
      ...base,
      outcome: 'failure',
      detail: `Forbidden: ${denial.permission} (${denial.reason})`,
      metadata: { permission: denial.permission, reason: denial.reason, role: denial.role },
    });
  } catch (error) {
    console.error('Authz denial audit skipped:', describeErrorForLog(error));
  }
}
