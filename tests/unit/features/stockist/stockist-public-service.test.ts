const mockCreateClient = jest.fn();
const mockCreatePublicClient = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
  createPublicClient: (...args: unknown[]) => mockCreatePublicClient(...args),
}));

import {
  PUBLIC_STOCKIST_FETCH_LIMIT,
  getHomePublicStockists,
  getPublicStockists,
} from '@/features/stockist/services/public';

type Result = { data: unknown; error: unknown };

// await したときに result を返せるよう、鎖自身を thenable にする
function setupChain(result: Result) {
  const chain: Record<string, unknown> = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.order = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.then = (
    resolve: (value: Result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  const from = jest.fn(() => chain);
  mockCreatePublicClient.mockResolvedValue({ from });
  return {
    from,
    chain: chain as Record<'select' | 'eq' | 'order' | 'limit', jest.Mock>,
    raw: chain,
  };
}

const ROW = {
  id: 1,
  name: 'A',
  address: '東京都港区',
  phone: '03-0000-0000',
  time: '11:00-19:00',
  holiday: '水',
  status: 'published',
  created_at: '2026-01-01',
  updated_at: '2026-01-02',
};

const PUBLIC_ROW = {
  id: 1,
  name: 'A',
  address: '東京都港区',
  phone: '03-0000-0000',
  time: '11:00-19:00',
  holiday: '水',
};

describe('getPublicStockists', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('DD-STOCKIST-003 引数なしなら Cookie を引き継がない公開用の client で stockists を published で絞り id 昇順に取り、上限の limit(200) を掛ける', async () => {
    const { from, chain } = setupChain({ data: [], error: null });

    await getPublicStockists();

    expect(mockCreatePublicClient).toHaveBeenCalledWith();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith('stockists');
    expect(chain.select).toHaveBeenCalledWith('id, name, address, phone, time, holiday, status');
    expect(chain.eq).toHaveBeenCalledWith('status', 'published');
    expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(chain.limit).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(200);
    expect(PUBLIC_STOCKIST_FETCH_LIMIT).toBe(200);
  });

  it('DD-STOCKIST-003 limit が 500 でも上限の limit(200) に切り詰める', async () => {
    const { chain } = setupChain({ data: [], error: null });

    await getPublicStockists({ limit: 500 });

    expect(chain.limit).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  it('DD-STOCKIST-003 limit が 6 なら limit(6) を呼ぶ', async () => {
    const { chain } = setupChain({ data: [], error: null });

    await getPublicStockists({ limit: 6 });

    expect(chain.limit).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(6);
  });

  it('DD-STOCKIST-003 limit が小数 2.7 なら切り捨てて limit(2) を呼ぶ', async () => {
    const { chain } = setupChain({ data: [], error: null });

    await getPublicStockists({ limit: 2.7 });

    expect(chain.limit).toHaveBeenCalledWith(2);
  });

  it.each([
    ['0', { limit: 0 }],
    ['-1', { limit: -1 }],
    ['NaN', { limit: Number.NaN }],
    ['Infinity', { limit: Number.POSITIVE_INFINITY }],
    ['-Infinity', { limit: Number.NEGATIVE_INFINITY }],
    ['limit 無しの空オブジェクト', {}],
    ['数でない文字列', { limit: '6' as unknown as number }],
    ['undefined', { limit: undefined }],
    ['1 未満の小数', { limit: 0.5 }],
  ])('DD-STOCKIST-003 不正な件数（%s）でも limit を外さず上限の limit(200) を掛ける', async (_label, options) => {
    const { chain } = setupChain({ data: [], error: null });

    await getPublicStockists(options);

    expect(chain.limit).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  it('DD-STOCKIST-003 行を6つの列に詰め直し、status・created_at・updated_at を返さない', async () => {
    setupChain({ data: [ROW, { ...ROW, id: 2, name: 'B' }], error: null });

    const result = await getPublicStockists();

    expect(result).toEqual([PUBLIC_ROW, { ...PUBLIC_ROW, id: 2, name: 'B' }]);
    for (const shop of result) {
      expect(Object.keys(shop).sort()).toEqual([
        'address',
        'holiday',
        'id',
        'name',
        'phone',
        'time',
      ]);
    }
  });

  it('DD-STOCKIST-003 DB の誤りは console.error に書いて空の配列を返す', async () => {
    const error = { message: 'boom secret', details: 'detail secret', code: '500' };
    setupChain({ data: null, error });

    const result = await getPublicStockists();

    expect(result).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('Failed to fetch public stockists:', {
      name: 'UnknownError',
      code: '500',
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret');
  });

  it('DD-STOCKIST-003 data が null で誤りも無いなら空の配列を返し、console.error を呼ばない', async () => {
    setupChain({ data: null, error: null });

    const result = await getPublicStockists();

    expect(result).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-003 client を作れない時の例外は受け止めず呼んだ側へ出す', async () => {
    mockCreatePublicClient.mockRejectedValue(new Error('no client'));

    await expect(getPublicStockists()).rejects.toThrow('no client');
  });

  it('DD-STOCKIST-003 問い合わせが例外を投げた時も受け止めず呼んだ側へ出す', async () => {
    const { raw } = setupChain({ data: [], error: null });
    raw.then = (_resolve: unknown, reject: (reason: unknown) => unknown) =>
      Promise.reject(new Error('query failed')).catch(reject);

    await expect(getPublicStockists()).rejects.toThrow('query failed');
  });
});

describe('getHomePublicStockists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DD-STOCKIST-004 limit(6) と published の絞りを呼ぶ', async () => {
    const { from, chain } = setupChain({ data: [], error: null });

    await getHomePublicStockists();

    expect(from).toHaveBeenCalledWith('stockists');
    expect(chain.eq).toHaveBeenCalledWith('status', 'published');
    expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    expect(chain.limit).toHaveBeenCalledTimes(1);
    expect(chain.limit).toHaveBeenCalledWith(6);
  });

  it('DD-STOCKIST-004 3件の行を6つの列に詰め直した3件で返す', async () => {
    setupChain({
      data: [ROW, { ...ROW, id: 2 }, { ...ROW, id: 3 }],
      error: null,
    });

    const result = await getHomePublicStockists();

    expect(result).toEqual([PUBLIC_ROW, { ...PUBLIC_ROW, id: 2 }, { ...PUBLIC_ROW, id: 3 }]);
    expect(result.every((shop) => !('status' in shop))).toBe(true);
  });
});
