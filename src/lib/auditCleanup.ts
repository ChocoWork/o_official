import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * Delete audit logs older than `retentionDays` (default 365 days).
 * Returns the deleted row count and the deleted rows.
 *
 * @impl IMPL-ADMIN-145
 * @design DD-ADMIN-015
 * @remarks 使うか消すかが決まるまで残す（ARC-ADMIN-005）。audit_logs は authenticated から消せないので service role で消す。
 */
export async function cleanupAuditLogs({ retentionDays = 365 }: { retentionDays?: number } = {}) {
  const supabase = await createServiceRoleClient();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Supabase PostgREST: delete where created_at < cutoff
  // Note: use .lt('created_at', cutoff) to perform deletion
  const { data, error, count } = await supabase
    .from('audit_logs')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff);

  if (error) {
    throw error;
  }

  return { deleted: count ?? 0, data };
}

export default cleanupAuditLogs;