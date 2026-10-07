/** 明細ごとのお届けの目安。在庫で賄えるなら stock（在庫あり）、賄えなければ backorder（受注生産） */
export type Fulfillment = 'stock' | 'backorder';

/** 目安を問い合わせる1行。カートの行からも下書きの写しからも作れる */
export type FulfillmentQueryLine = {
  item_id: number;
  color: string | null;
  size: string | null;
  quantity: number;
};

export type FulfillmentPreviewLine = {
  /** 渡した順（1始まり） */
  lineNo: number;
  itemId: number;
  color: string | null;
  size: string | null;
  quantity: number;
  variantId: number | null;
  fulfillment: Fulfillment;
};

/** service_role の Supabase クライアントの rpc だけを使う（テストで差し替えやすくする） */
export type RpcClient = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

type PreviewRow = {
  line_no: number | string;
  item_id: number | string;
  color: string | null;
  size: string | null;
  quantity: number | string;
  variant_id: number | string | null;
  fulfillment: string;
};

/**
 * 明細ごとのお届けの目安を、受付 RPC と同じ規則で読む（グループ F 設計書 5-1、計画の決め事 D3）。
 * 同じバリアントの明細は数量を合わせて在庫と比べる。在庫の数そのものは返さない。
 * DB の関数は service_role だけが実行できる。
 */
export async function previewFulfillment(
  client: RpcClient,
  lines: FulfillmentQueryLine[],
): Promise<FulfillmentPreviewLine[]> {
  if (lines.length === 0) {
    return [];
  }

  const { data, error } = await client.rpc('preview_checkout_fulfillment', {
    _items_snapshot: lines.map((line) => ({
      item_id: line.item_id,
      color: line.color,
      size: line.size,
      quantity: line.quantity,
    })),
  });

  if (error) {
    throw error;
  }

  return ((data ?? []) as PreviewRow[]).map((row) => ({
    lineNo: Number(row.line_no),
    itemId: Number(row.item_id),
    color: row.color,
    size: row.size,
    quantity: Number(row.quantity),
    variantId: row.variant_id === null ? null : Number(row.variant_id),
    // 知らない値で「在庫あり」と見せると、お届けが遅れることを伝えられない
    fulfillment: row.fulfillment === 'stock' ? 'stock' : 'backorder',
  }));
}
