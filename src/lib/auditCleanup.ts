import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * Delete audit logs older than `retentionDays` (default 365 days).
 * Returns the Supabase response object.
 */
export async function cleanupAuditLogs({ retentionDays = 365 }: { retentionDays?: number } = {}) {
  const supabase = createServiceRoleClient();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Supabase PostgREST: delete where created_at < cutoff
  // Note: use .lt('created_at', cutoff) to perform deletion
  const { data, error } = await supabase.from('audit_logs').delete().lt('created_at', cutoff);

  if (error) {
    throw error;
  }

  return { deleted: data ? data.length : 0, data };
}

export default cleanupAuditLogs;