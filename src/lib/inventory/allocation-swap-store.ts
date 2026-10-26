import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ALLOCATION_SWAP_ERRORS, ALLOCATION_SWAP_TEXT, parseAllocationSwapCandidates, parseAllocationSwapResult,
  type AllocationSwapCandidate, type AllocationSwapInput, type AllocationSwapResult,
} from './allocation-swap-types';

/** 生の文を保持しない。未知のSQLSTATEだけを非列挙の診断用プロパティへ残す。 */
export class AllocationSwapError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly sqlstate?: string;
  constructor(code?: string, sqlstate?: unknown) {
    const entry = code !== undefined && Object.hasOwn(ALLOCATION_SWAP_ERRORS, code) ? ALLOCATION_SWAP_ERRORS[code] : undefined;
    super(entry ? entry[2] : ALLOCATION_SWAP_TEXT.failed);
    this.name = 'AllocationSwapError';
    this.status = entry ? entry[1] : 500;
    if (entry) this.code = code;
    if (!entry && typeof sqlstate === 'string' && sqlstate.length === 5 && /^[0-9A-Z]{5}$/.test(sqlstate)) {
      Object.defineProperty(this, 'sqlstate', { value: sqlstate, enumerable: false });
    }
  }
}

function sqlstateOf(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function classify(error: unknown): AllocationSwapError {
  if (error !== null && typeof error === 'object' && 'message' in error && 'code' in error
    && typeof error.message === 'string' && Object.hasOwn(ALLOCATION_SWAP_ERRORS, error.message)
    && ALLOCATION_SWAP_ERRORS[error.message][0] === error.code) return new AllocationSwapError(error.message);
  return new AllocationSwapError(undefined, sqlstateOf(error));
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let response;
  try { response = await client.rpc(name, args); } catch (error) { throw new AllocationSwapError(undefined, sqlstateOf(error)); }
  if (response.error) throw classify(response.error);
  return response.data as unknown;
}

/** 再送時もDBの同じ要求番号へ委ね、書込みを自動でやり直さない。 */
export async function swapOrderAllocations(client: SupabaseClient, actorId: string, orderId: string, input: AllocationSwapInput): Promise<AllocationSwapResult> {
  const raw = await rpc(client, 'admin_swap_order_allocations', {
    _order_id: orderId, _taker_order_item_id: input.takerOrderItemId, _donor_order_item_id: input.donorOrderItemId,
    _quantity: input.quantity, _reason: input.reason, _actor_id: actorId, _request_key: input.requestKey,
  });
  try { return parseAllocationSwapResult(raw, orderId, input); } catch { throw new AllocationSwapError(); }
}

/** 候補はDBの単一スナップショットを読み、公開型へ変換する。 */
export async function listAllocationSwapCandidates(client: SupabaseClient, actorId: string, orderId: string, takerOrderItemId: string): Promise<AllocationSwapCandidate[]> {
  const raw = await rpc(client, 'list_admin_allocation_swap_candidates', { _order_id: orderId, _taker_order_item_id: takerOrderItemId, _actor_id: actorId });
  try {
    if (!Array.isArray(raw)) throw new Error();
    return parseAllocationSwapCandidates(raw.map((row: unknown) => {
      if (row === null || typeof row !== 'object') throw new Error();
      const value = row as Record<string, unknown>;
      return { donorOrderId: value.donor_order_id, donorOrderItemId: value.donor_order_item_id, orderCreatedAt: value.order_created_at, swappableQuantity: value.swappable_quantity, takerQuantity: value.taker_quantity };
    }), orderId);
  } catch { throw new AllocationSwapError(); }
}
