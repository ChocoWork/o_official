import { createServiceRoleClient } from '@/lib/supabase/server';

export type CounterRow = {
  id?: number;
  ip?: string;
  endpoint: string;
  bucket: string; // ISO timestamp representing the bucket
  count: number;
};

function normalizeCounterTarget({
  ip,
  endpoint,
  subject,
}: {
  ip?: string | null;
  endpoint: string;
  subject?: string | null;
}) {
  return {
    effectiveIp: subject ? null : ip ?? null,
    effectiveEndpoint: subject ? `${endpoint}|acct:${subject}` : endpoint,
  };
}

function extractCounterResult(data: unknown): number {
  const result =
    typeof data === 'number'
      ? data
      : Array.isArray(data)
      ? data[0]
      : typeof data === 'object' && data !== null && 'count' in data
      ? (data as { count: unknown }).count
      : null;

  if (typeof result !== 'number') {
    throw new Error('rateLimit: invalid RPC result');
  }

  return result;
}

// Increment the counter for the given ip/endpoint/bucket and return the new count.
export async function incrementCounter({ ip, endpoint, bucket, subject }: { ip?: string | null; endpoint: string; bucket: string; subject?: string | null }): Promise<number> {
  const service = await createServiceRoleClient();
  const { effectiveIp, effectiveEndpoint } = normalizeCounterTarget({ ip, endpoint, subject });

  try {
    const { data, error } = await service.rpc('increment_rate_limit_counter', {
      _ip: effectiveIp,
      _endpoint: effectiveEndpoint,
      _bucket: bucket,
    });

    if (error) {
      console.error('rateLimit: rpc error', error);
      throw new Error((error as { message?: string }).message ?? 'rateLimit RPC error');
    }

    return extractCounterResult(data);
  } catch (err) {
    console.error('incrementCounter error:', err);
    throw err;
  }
}

export async function incrementCounterBy({
  ip,
  endpoint,
  bucket,
  increment,
  subject,
}: {
  ip?: string | null;
  endpoint: string;
  bucket: string;
  increment: number;
  subject?: string | null;
}): Promise<number> {
  const service = await createServiceRoleClient();
  const { effectiveIp, effectiveEndpoint } = normalizeCounterTarget({ ip, endpoint, subject });

  try {
    const { data, error } = await service.rpc('increment_rate_limit_counter', {
      _ip: effectiveIp,
      _endpoint: effectiveEndpoint,
      _bucket: bucket,
      _increment: Math.max(1, Math.floor(increment)),
    });

    if (error) {
      console.error('rateLimit: weighted rpc error', error);
      throw new Error((error as { message?: string }).message ?? 'rateLimit weighted RPC error');
    }

    return extractCounterResult(data);
  } catch (err) {
    console.error('incrementCounterBy error:', err);
    throw err;
  }
}
