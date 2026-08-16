import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeAccountingDatabase, StripeAccountingTable } from './accounting-types';

type QueryResult = { data: unknown; error: { message?: string } | null };

function unwrap(result: QueryResult): unknown {
  if (result.error) {
    throw new Error(result.error.message ?? 'Stripe accounting query failed');
  }
  return result.data;
}

/**
 * service-role の Supabase クライアントを StripeAccountingDatabase へ適合させる。
 * 会計同期・仕訳投影は Supabase を直接知らないため、実行時の DB 実体をここだけに閉じる。
 */
export function createStripeAccountingDatabase(
  client: SupabaseClient
): StripeAccountingDatabase {
  return {
    async findOrderByPaymentIntent(paymentIntentId: string) {
      const result = (await client
        .from('orders')
        .select('id, currency')
        .eq('payment_intent_id', paymentIntentId)
        .maybeSingle()) as QueryResult;
      return (unwrap(result) as { id: string; currency: string } | null) ?? null;
    },

    async findById(table: StripeAccountingTable, id: string) {
      const result = (await client
        .from(table)
        .select('*')
        .eq('id', id)
        .maybeSingle()) as QueryResult;
      return (unwrap(result) as Record<string, unknown> | null) ?? null;
    },

    async insert(table: StripeAccountingTable, values: Record<string, unknown>) {
      const result = (await client
        .from(table)
        .insert(values)
        .select()
        .single()) as QueryResult;
      return unwrap(result) as Record<string, unknown>;
    },

    async updateById(
      table: StripeAccountingTable,
      id: string,
      values: Record<string, unknown>
    ) {
      const result = (await client
        .from(table)
        .update(values)
        .eq('id', id)
        .select()
        .single()) as QueryResult;
      return unwrap(result) as Record<string, unknown>;
    },
  };
}
