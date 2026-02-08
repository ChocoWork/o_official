import { createServiceRoleClient } from '@/lib/supabase/server';

export type AuditEvent = {
  action: string;
  actor_id?: string | null;
  actor_email?: string | null;
  resource?: string | null;
  resource_id?: string | null;
  outcome: 'success' | 'failure' | 'error' | 'conflict' | string;
  detail?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
};

export function maskAuditEvent(event: AuditEvent) {
  // 深いコピーして元のオブジェクトを壊さない
  const masked: AuditEvent = JSON.parse(JSON.stringify(event));

  // マスク対象キー（小文字比較）
  const sensitiveKeyPatterns = [/password/, /^pass$/, /^pwd$/, /token/, /secret/, /ssn/, /card/, /cvv/, /credit_card/, /pan/, /number/];

  if (masked.metadata && typeof masked.metadata === 'object') {
    for (const [k, v] of Object.entries(masked.metadata)) {
      const lower = k.toLowerCase();
      if (sensitiveKeyPatterns.some((r) => r.test(lower))) {
        masked.metadata![k] = '[REDACTED]';
      }
    }
  }

  if (masked.detail && typeof masked.detail === 'string') {
    // JWT のような header.payload.signature をマスク
    masked.detail = masked.detail.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
    // 長いトークン（32 文字以上の英数字・.-_）をマスク
    masked.detail = masked.detail.replace(/[A-Za-z0-9\-_=]{32,}/g, '[REDACTED_TOKEN]');
    // パスワードの明示的な記述（password=xxx）をマスク
    masked.detail = masked.detail.replace(/(password|pwd|pass)\s*[=:]\s*[^\s&;]+/gi, '$1=[REDACTED]');
  }

  return masked;
}

export async function logAudit(event: AuditEvent) {
  try {
    const supabase = await createServiceRoleClient();

    const masked = maskAuditEvent(event);

    await supabase.from('audit_logs').insert([
      {
        action: masked.action,
        actor_id: masked.actor_id,
        actor_email: masked.actor_email,
        resource: masked.resource,
        resource_id: masked.resource_id,
        outcome: masked.outcome,
        detail: masked.detail,
        ip: masked.ip,
        user_agent: masked.user_agent,
        metadata: masked.metadata ?? null,
        created_at: masked.created_at ?? new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // 監査ログは冗長性を持たせるべきだが、まずはサーバログに出力する
    console.warn('Failed to write audit log:', err, event);
  }
}

export default logAudit;
