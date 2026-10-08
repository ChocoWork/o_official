import type { SupabaseClient } from '@supabase/supabase-js';

export type ShoppingOwnerTable = 'carts' | 'wishlists';
export type ShoppingOwnerRef = { kind: 'member'; userId: string } | { kind: 'guest'; tokenHash: string };

function ownerColumn(owner: ShoppingOwnerRef): { column: 'user_id' | 'guest_token_hash'; value: string } {
  return owner.kind === 'member'
    ? { column: 'user_id', value: owner.userId }
    : { column: 'guest_token_hash', value: owner.tokenHash };
}

export async function findOwnerRowId(
  supabase: SupabaseClient,
  table: ShoppingOwnerTable,
  owner: ShoppingOwnerRef,
): Promise<string | null> {
  const { column, value } = ownerColumn(owner);
  const { data, error } = await supabase.from(table).select('id').eq(column, value).maybeSingle<{ id: string }>();
  if (error) {
    throw error;
  }
  return data?.id ?? null;
}

/** 持ち主の行を1つにする（会員1人・印1つにつき1つ。表の一意の決まりで同時に作っても1つになる） */
export async function ensureOwnerRowId(
  supabase: SupabaseClient,
  table: ShoppingOwnerTable,
  owner: ShoppingOwnerRef,
): Promise<string> {
  const { column, value } = ownerColumn(owner);
  const { error } = await supabase.from(table).upsert({ [column]: value }, { onConflict: column, ignoreDuplicates: true });
  if (error) {
    throw error;
  }
  const id = await findOwnerRowId(supabase, table, owner);
  if (!id) {
    throw new Error(`${table} owner row was not created`);
  }
  return id;
}
