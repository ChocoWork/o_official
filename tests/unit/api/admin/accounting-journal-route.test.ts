/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/authenticate', () => ({ verifyAccessToken: jest.fn(), checkAuthSessionLiveness: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { GET as journalGet } from '@/app/api/admin/accounting/journal/route';
import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { createServiceRoleClient } from '@/lib/supabase/server';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = uuid(90); const PERIOD = uuid(1); const RECORDER = uuid(80);
const READ = 'admin.finance.read'; const MANAGE = 'admin.accounting.settings.manage';
const claims = (aal: string) => ({ sub: ACTOR, session_id: 'session-1', aal, email: 'owner@example.test', app_metadata: { role: 'admin' } });
const entryRow = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: uuid(100 + n), period_id: PERIOD, entry_no: n, entry_date: '2026-03-01', event_kind: 'manual_entry', dedupe_key: `manual_entry:${n}:0`,
  description: '文具', recorded_at: '2026-03-01T01:00:00+00:00', recorded_by: RECORDER, is_late: false, reverses_entry_id: null, reason: null,
  source_table: 'admin_finance_expenses', source_id: String(n), migrated_from: null, migrated_at: null, source_recorded_at: null,
  lines: [
    { line_no: 1, account_code: '5110', debit: 1200, credit: 0, sub_account: null, counterparty: '文具店', order_id: null, memo: null },
    { line_no: 2, account_code: '1040', debit: 0, credit: 1200, sub_account: null, counterparty: null, order_id: null, memo: null },
  ],
  legacy: { revision_count: 0, receipt_count: 1 },
  ...overrides,
});
const periodRow = {
  id: PERIOD, business_type: 'soleProprietor', name: '2026年（個人）', starts_on: '2026-01-01', ends_on: '2026-12-31',
  corporate_tax_extension_months: 0, consumption_tax_extension_months: 0, consumption_tax_status: 'exempt', consumption_taxable_from: null,
  version: '1', legacy_fiscal_year: 2026,
};

const seq: string[] = [];
const rpcImpl = jest.fn();
const grants = { current: [READ] as string[] };
const db = { periods: [periodRow] as unknown[] };
const service = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, or: async () => ({ data: [{ roles: { role_permissions: grants.current.map((code) => ({ permissions: { code } })) } }], error: null }) };
    return chain;
  },
  rpc: (name: string, args: Record<string, unknown>) => { seq.push(`rpc:${name}`); return rpcImpl(name, args); },
};
const defaultRpc = (name: string): { data: unknown; error: null } => {
  switch (name) {
    case 'list_accounting_periods': return { data: db.periods, error: null };
    case 'list_accounting_journal': return { data: { entries: [entryRow(1), entryRow(2)], next_after_date: '2026-03-01', next_after_no: 2 }, error: null };
    case 'get_accounting_opening': return { data: [{ account_code: '2910', signed_amount: 0, basis: 'carryover' }], error: null };
    case 'list_journal_shipment_meta': return { data: [], error: null };
    default: throw new Error(`unexpected rpc ${name}`);
  }
};
const base = 'https://example.test/api/admin/accounting/journal';
const get = (query = `periodId=${PERIOD}`) => journalGet(new Request(`${base}?${query}`));
async function read(response: Response) {
  expect(response.headers.get('cache-control')).toContain('no-store');
  return (await response.json()) as Record<string, unknown>;
}
const ENTRY_KEYS = ['dedupeKey', 'description', 'entryDate', 'entryNo', 'eventKind', 'id', 'isLate', 'legacy', 'lines', 'migratedAt', 'migratedFrom', 'periodId', 'reason', 'recordedAt', 'recordedBy', 'reversesEntryId', 'sourceId', 'sourceRecordedAt', 'sourceTable'];

beforeEach(() => {
  jest.resetAllMocks();
  seq.length = 0; grants.current = [READ]; db.periods = [periodRow];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (verifyAccessToken as jest.Mock).mockImplementation(async () => { seq.push('auth'); return { ok: true, claims: claims('aal2') }; });
  (checkAuthSessionLiveness as jest.Mock).mockResolvedValue('active');
  (createServiceRoleClient as jest.Mock).mockResolvedValue(service);
  rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/accounting/journal', () => {
  test('FREQ-555-AC-04: 仕訳の読みrouteはperiodIdを検証しno-storeで返し本文に不要な識別子を含めない', async () => {
    const response = await get(`periodId=${PERIOD}&from=2026-01-01&to=2026-03-31&limit=2&afterEntryDate=2026-02-01&afterEntryNo=7`);
    expect(response.status).toBe(200);
    const body = await read(response);
    expect(Object.keys(body).sort()).toEqual(['data', 'permissions']);
    expect(body.permissions).toEqual({ manageSettings: false });
    const data = body.data as { entries: Record<string, unknown>[]; nextAfter: unknown; opening: unknown[]; shipmentMeta: unknown[] };
    expect(Object.keys(data).sort()).toEqual(['entries', 'nextAfter', 'opening', 'shipmentMeta']);
    // 出荷の仕訳が1つも無いページでは、出荷の日の読み口を呼ばず空の一覧を返す
    expect(data.shipmentMeta).toEqual([]);
    expect(rpcImpl).not.toHaveBeenCalledWith('list_journal_shipment_meta', expect.anything());
    for (const entry of data.entries) expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
    expect(data.entries[0].legacy).toEqual({ revisionCount: 0, receiptCount: 1 });
    expect(data.nextAfter).toEqual({ entryDate: '2026-03-01', entryNo: 2 });
    expect(data.opening).toEqual([{ accountCode: '2910', signedAmount: 0, basis: 'carryover' }]);
    // DB の列名・閲覧者の番号・期間の旧番号は本文に出さない。
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/"[a-z]+_[a-z_]+":/);
    expect(text).not.toContain(ACTOR);
    expect(text).not.toContain('legacy_fiscal_year');
    expect(rpcImpl).toHaveBeenCalledWith('list_accounting_journal', {
      _period_id: PERIOD, _from: '2026-01-01', _to: '2026-03-31', _limit: 2, _after_entry_date: '2026-02-01', _after_entry_no: 7,
    });
    expect(rpcImpl).toHaveBeenCalledWith('get_accounting_opening', { _period_id: PERIOD });
    expect(mockRate).not.toHaveBeenCalled(); expect(mockCsrf).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();

    // periodId・日付・件数・目印の不正は RPC を呼ばず 400。
    rpcImpl.mockClear();
    for (const query of [
      'periodId=not-a-uuid', `periodId=${PERIOD}&from=2026-02-30`, `periodId=${PERIOD}&from=2026-04-01&to=2026-03-01`, `periodId=${PERIOD}&limit=0`,
      `periodId=${PERIOD}&limit=201`, `periodId=${PERIOD}&limit=1.5`, `periodId=${PERIOD}&afterEntryDate=2026-02-01`, `periodId=${PERIOD}&afterEntryNo=3`,
      `periodId=${PERIOD}&periodId=${PERIOD}`, `periodId=${PERIOD}&actorId=${ACTOR}`,
    ]) {
      const bad = await get(query);
      expect([query, bad.status, await read(bad)]).toEqual([query, 400, { code: 'ACCOUNTING_ARGUMENT_INVALID', error: '入力を確かめてください。' }]);
    }
    expect(rpcImpl).not.toHaveBeenCalled();
  });

  test('FREQ-555-AC-04: 期間が1つも無いときは404でなく空の一覧を返す', async () => {
    const empty = { data: { entries: [], nextAfter: null, opening: [], shipmentMeta: [] }, permissions: { manageSettings: false } };
    // periodId を省略し期間が無い。
    db.periods = [];
    const none = await get('');
    expect([none.status, await read(none)]).toEqual([200, empty]);
    expect(seq).toEqual(['auth', 'rpc:list_accounting_periods']);
    // 渡した期間が無い（DB が ACCOUNTING_NOT_FOUND）。
    rpcImpl.mockImplementation(async (name: string) => (name === 'list_accounting_journal' ? { data: null, error: { message: 'ACCOUNTING_NOT_FOUND', code: 'P0002', details: null, hint: null } } : defaultRpc(name)));
    const missing = await get();
    expect([missing.status, await read(missing)]).toEqual([200, empty]);
    // 期間があるのに periodId を省略したら 400。
    db.periods = [periodRow];
    rpcImpl.mockImplementation(async (name: string) => defaultRpc(name));
    expect((await get('')).status).toBe(400);
  });

  test('FREQ-555-AC-04: 読みはadmin.finance.readを求め、aal1を断り、未知の失敗は固定の500', async () => {
    grants.current = [MANAGE];
    expect((await get()).status).toBe(403);
    grants.current = [READ, MANAGE];
    (verifyAccessToken as jest.Mock).mockImplementationOnce(async () => ({ ok: true, claims: claims('aal1') }));
    expect((await get()).status).toBe(403);
    expect(rpcImpl).not.toHaveBeenCalled();
    const ok = await get();
    expect((await read(ok)).permissions).toEqual({ manageSettings: true });
    rpcImpl.mockImplementation(async (name: string) => (name === 'get_accounting_opening' ? { data: null, error: { message: 'boom secret', code: 'XX000', details: 'secret', hint: null } } : defaultRpc(name)));
    const failed = await get();
    expect([failed.status, await read(failed)]).toEqual([500, { error: '会計の処理に失敗しました。' }]);
  });
});

describe('出荷の仕訳に付ける出荷した日と登録した日', () => {
  test('FREQ-564-AC-04: 仕訳のrouteは出荷の仕訳にだけ出荷した日と発送票を確定した日を付ける', async () => {
    const shipmentEntry = entryRow(3, { event_kind: 'shipment_confirmed', dedupe_key: 'shipment_confirmed:slip:0', source_table: 'shipment_slips', source_id: uuid(500) });
    rpcImpl.mockImplementation(async (name: string) => {
      if (name === 'list_accounting_journal') return { data: { entries: [entryRow(1), shipmentEntry], next_after_date: null, next_after_no: null }, error: null };
      if (name === 'list_journal_shipment_meta') {
        return { data: [{ entry_id: shipmentEntry.id, slip_number: 'SL-20261109-0001', shipment_date: '2026-11-05', confirmed_at: '2026-11-09T01:00:00+00:00' }], error: null };
      }
      return defaultRpc(name);
    });
    const response = await get();
    expect(response.status).toBe(200);
    const body = await read(response);
    expect((body.data as { shipmentMeta: unknown[] }).shipmentMeta).toEqual([
      { entryId: shipmentEntry.id, slipNumber: 'SL-20261109-0001', shipmentDate: '2026-11-05', confirmedAt: '2026-11-09T01:00:00+00:00' },
    ]);
    // 出荷の仕訳の番号だけを渡す（手入力の仕訳は渡さない）
    expect(rpcImpl).toHaveBeenCalledWith('list_journal_shipment_meta', { _entry_ids: [shipmentEntry.id] });
    // 既存の欄は消えない
    expect(Object.keys(body.data as object).sort()).toEqual(['entries', 'nextAfter', 'opening', 'shipmentMeta']);
    expect(JSON.stringify(body)).not.toMatch(/"[a-z]+_[a-z_]+":/);
  });

  test('FREQ-564-AC-04: 出荷の日の読み口が壊れても仕訳の一覧は返し、shipmentMetaはnullと固定の文になる（生の文を出さない）', async () => {
    const shipmentEntry = entryRow(3, { source_table: 'shipment_slips', source_id: uuid(500) });
    rpcImpl.mockImplementation(async (name: string) => {
      if (name === 'list_accounting_journal') return { data: { entries: [shipmentEntry], next_after_date: null, next_after_no: null }, error: null };
      if (name === 'list_journal_shipment_meta') return { data: null, error: { message: 'boom secret', code: 'XX000', details: 'secret', hint: null } };
      return defaultRpc(name);
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await get();
      expect(response.status).toBe(200);
      const body = await read(response);
      const data = body.data as { entries: unknown[]; shipmentMeta: unknown; shipmentMetaNote: string };
      expect(data.entries).toHaveLength(1);
      expect(data.shipmentMeta).toBeNull();
      expect(data.shipmentMetaNote).toBe('出荷した日と登録した日を読み込めませんでした。仕訳はそのまま使えます。');
      expect(JSON.stringify(body)).not.toMatch(/boom|secret/);
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/boom|secret/);
    } finally {
      spy.mockRestore();
    }
  });
});
