import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  StripeAccountingDatabase,
  StripeAccountingTable,
  StripeDisputeEventInput,
  StripeDisputeInput,
} from './accounting-types';

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

    // 書くのは DB の関数だけ（表への INSERT・UPDATE は service_role に付けていない）。結果は dispute の番号と、履歴を足したか。
    async recordDispute(dispute: StripeDisputeInput, event: StripeDisputeEventInput | null) {
      const result = (await client.rpc('record_stripe_dispute', {
        _dispute: {
          id: dispute.id,
          payment_intent_id: dispute.paymentIntentId,
          charge_id: dispute.chargeId,
          order_id: dispute.orderId,
          amount: dispute.amount,
          currency: dispute.currency,
          reason: dispute.reason,
          status: dispute.status,
          is_charge_refundable: dispute.isChargeRefundable,
          evidence_due_by: dispute.evidenceDueBy,
          evidence_details: dispute.evidenceDetails,
          stripe_created_at: dispute.stripeCreatedAt,
          synced_at: dispute.syncedAt,
        },
        _event: event && {
          stripe_event_id: event.stripeEventId,
          event_type: event.eventType,
          status: event.status,
          occurred_at: event.occurredAt,
          stripe_event_created_at: event.stripeEventCreatedAt,
          balance_transaction_ids: event.balanceTransactionIds,
          raw_payload: event.rawPayload,
        },
      })) as QueryResult;
      const data = unwrap(result) as { dispute_id: string; event_inserted: boolean };
      return { disputeId: data.dispute_id, eventInserted: data.event_inserted === true };
    },

    async findDisputeStatus(disputeId: string) {
      const result = (await client
        .from('stripe_disputes')
        .select('status')
        .eq('id', disputeId)
        .maybeSingle()) as QueryResult;
      return (unwrap(result) as { status: string } | null)?.status ?? null;
    },

    async listOpenDisputeIds(limit: number) {
      const result = (await client
        .from('stripe_disputes')
        .select('id')
        .not('status', 'in', '(won,lost,warning_closed)')
        .order('stripe_created_at', { ascending: true })
        .limit(limit)) as QueryResult;
      return ((unwrap(result) as Array<{ id: string }> | null) ?? []).map((row) => row.id);
    },

    async hasLostEventTime(disputeId: string) {
      const result = (await client
        .from('stripe_dispute_events')
        .select('id')
        .eq('dispute_id', disputeId)
        .eq('status', 'lost')
        .not('stripe_event_created_at', 'is', null)
        .limit(1)) as QueryResult;
      return ((unwrap(result) as unknown[] | null) ?? []).length > 0;
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
