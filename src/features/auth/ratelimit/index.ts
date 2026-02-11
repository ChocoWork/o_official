import { createServiceRoleClient } from '@/lib/supabase/server';

export type CounterRow = {
  id?: number;
  ip?: string;
  endpoint: string;
  bucket: string; // ISO timestamp representing the bucket
  count: number;
};

// Increment the counter for given ip/endpoint/bucket and return the new count.
export async function incrementCounter({ ip, endpoint, bucket, subject }: { ip?: string | null; endpoint: string; bucket: string; subject?: string | null }): Promise<number> {
  const service = await createServiceRoleClient();

  try {
    // Try to find existing row
    // When subject (e.g., email) is provided, store ip as null and encode subject into endpoint
    const effectiveIp = subject ? null : ip ?? null;
    const effectiveEndpoint = subject ? `${endpoint}|acct:${subject}` : endpoint;

    const { data: existing, error: selectErr } = await service
      .from('rate_limit_counters')
      .select('count')
      .eq('ip', effectiveIp)
      .eq('endpoint', effectiveEndpoint)
      .eq('bucket', bucket)
      .maybeSingle();

    if (selectErr) {
      console.error('rateLimit: select error', selectErr);
      throw selectErr;
    }

    if (existing && existing.count != null) {
      const newCount = (existing.count as number) + 1;
      const { error: updateErr } = await service
        .from('rate_limit_counters')
        .update({ count: newCount, last_seen_at: new Date().toISOString() })
        .eq('ip', effectiveIp)
        .eq('endpoint', effectiveEndpoint)
        .eq('bucket', bucket);
      if (updateErr) {
        console.error('rateLimit: update error', updateErr);
        throw updateErr;
      }
      return newCount;
    }

    // Insert new row
    const { error: insertErr } = await service.from('rate_limit_counters').insert([
      { ip: effectiveIp, endpoint: effectiveEndpoint, bucket, count: 1, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString() },
    ]);
    if (insertErr) {
      console.error('rateLimit: insert error', insertErr);
      throw insertErr;
    }
    return 1;
  } catch (err) {
    // Let caller decide how to handle DB errors (fail-open)
    console.error('incrementCounter error:', err);
    throw err;
  }
}
