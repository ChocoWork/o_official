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
  created_at?: string | null;
};

export async function logAudit(event: AuditEvent) {
  try {
    // 非同期で DB 挿入を試みる（テーブルが無ければ console に出す）
    const supabase = createServiceRoleClient();
    await supabase.from('audit_logs').insert([
      {
        action: event.action,
        actor_id: event.actor_id,
        actor_email: event.actor_email,
        resource: event.resource,
        resource_id: event.resource_id,
        outcome: event.outcome,
        detail: event.detail,
        ip: event.ip,
        user_agent: event.user_agent,
      },
    ]);
  } catch (err) {
    // 監査ログは冗長性を持たせるべきだが、まずはサーバログに出力する
    console.warn('Failed to write audit log:', err, event);
  }
}

export default logAudit;
