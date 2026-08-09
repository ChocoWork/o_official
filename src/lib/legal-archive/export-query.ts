import type {
  LegalArchiveOrder,
  LegalArchiveOrderItem,
  LegalArchivePage,
  LegalArchiveRevision,
} from './types';

type QueryResult = { data: unknown[] | null; error: { message?: string } | null };
type ArchiveQuery = PromiseLike<QueryResult> & {
  select(columns: string): ArchiveQuery;
  gte(column: string, value: string): ArchiveQuery;
  lt(column: string, value: string): ArchiveQuery;
  or(filter: string): ArchiveQuery;
  in(column: string, values: string[]): ArchiveQuery;
  order(column: string, options: { ascending: boolean }): ArchiveQuery;
  limit(value: number): ArchiveQuery;
};

export type LegalArchiveClient = { from(table: string): ArchiveQuery };

type Cursor = { createdAt: string; id: string };

function decodeCursor(value: string): Cursor {
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
  if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('Invalid archive cursor');
  }
  return parsed;
}

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function assertQuery(result: QueryResult, label: string): unknown[] {
  if (result.error) throw new Error(`Failed to fetch ${label}`);
  return result.data ?? [];
}

export async function fetchLegalArchivePage(input: {
  client: LegalArchiveClient;
  year: number;
  cursor: string | null;
  pageSize: number;
}): Promise<LegalArchivePage> {
  const lowerBound = new Date(Date.UTC(input.year - 1, 11, 31, 15)).toISOString();
  const upperBound = new Date(Date.UTC(input.year, 11, 31, 15)).toISOString();
  let orderQuery = input.client
    .from('orders')
    .select('*')
    .gte('created_at', lowerBound)
    .lt('created_at', upperBound)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(Math.min(input.pageSize, 500));

  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    orderQuery = orderQuery.or(
      `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`,
    );
  }

  const orders = assertQuery(await orderQuery, 'orders') as LegalArchiveOrder[];
  const orderIds = orders.map((order) => order.id);
  let orderItems: LegalArchiveOrderItem[] = [];
  let revisions: LegalArchiveRevision[] = [];

  if (orderIds.length > 0) {
    const itemResult = await input.client
      .from('order_items')
      .select('*')
      .in('order_id', orderIds)
      .order('order_id', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    orderItems = assertQuery(itemResult, 'order items') as LegalArchiveOrderItem[];

    const revisionResult = await input.client
      .from('order_revisions')
      .select('*')
      .in('order_id', orderIds)
      .order('order_id', { ascending: true })
      .order('changed_at', { ascending: true })
      .order('id', { ascending: true });
    revisions = assertQuery(revisionResult, 'order revisions') as LegalArchiveRevision[];
  }

  const totals = orders.reduce(
    (sum, order) => {
      const gross = Number(order.total_amount ?? 0);
      const refunded = Number(order.refunded_amount ?? 0);
      sum.grossAmount += gross;
      sum.refundedAmount += refunded;
      sum.netAmount += gross - refunded;
      return sum;
    },
    { grossAmount: 0, refundedAmount: 0, netAmount: 0 },
  );
  const last = orders.at(-1);

  return {
    orders,
    orderItems,
    revisions,
    nextCursor:
      last && orders.length === input.pageSize
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
    totals,
  };
}
