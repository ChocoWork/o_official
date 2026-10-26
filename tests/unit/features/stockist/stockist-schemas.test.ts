export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
      json: async () => body,
    }),
  },
}));

const {
  ADMIN_STOCKIST_COLUMNS,
  stockistStatusSchema,
  stockistWriteSchema,
  toInvalidStockistResponse,
} = require('@/features/stockist/schemas');

const validBody = {
  name: '本店 Le Fil',
  address: '東京都港区南青山 1-1-1',
  phone: '03-1234-5678',
  time: '11:00-19:00',
  holiday: '水曜',
  status: 'private',
};

function fieldsOf(patch: Record<string, unknown>): string[] {
  const parsed = stockistWriteSchema.safeParse({ ...validBody, ...patch });
  return parsed.success
    ? []
    : Array.from(new Set(parsed.error.issues.map((issue: { path: string[] }) => issue.path[0])));
}

describe('ADMIN_STOCKIST_COLUMNS', () => {
  it('DD-STOCKIST-034 管理の応答の列は 8 列で、created_at と * を含まない', () => {
    expect(ADMIN_STOCKIST_COLUMNS).toBe(
      'id, name, address, phone, time, holiday, status, updated_at',
    );
    expect(ADMIN_STOCKIST_COLUMNS.split(',').map((column: string) => column.trim())).toHaveLength(8);
  });
});

describe('stockistStatusSchema', () => {
  it('DD-STOCKIST-034 private と published だけを通す', () => {
    expect(stockistStatusSchema.safeParse('private').success).toBe(true);
    expect(stockistStatusSchema.safeParse('published').success).toBe(true);
    expect(stockistStatusSchema.safeParse('draft').success).toBe(false);
  });
});

describe('stockistWriteSchema の 1 行の文字', () => {
  it.each(['name', 'address', 'time', 'holiday'])(
    'DD-STOCKIST-034 %s は全角空白入りの 1 行の文字を通す',
    (field) => {
      expect(fieldsOf({ [field]: '本店\u3000Le Fil' })).toEqual([]);
    },
  );

  it.each([
    ['改行', '本店\nInjected'],
    ['復帰', '本店\rInjected'],
    ['タブ', '本店\tInjected'],
    ['ゼロ幅空白（書式文字）', '本店\u200b'],
    ['双方向制御（書式文字）', '本店\u202eEvil'],
    ['行区切り', '本店\u2028Injected'],
    ['段落区切り', '本店\u2029Injected'],
    ['制御文字', '本店\u0007'],
  ])('DD-STOCKIST-034 店名に%sを含むと拒む', (_label, value) => {
    expect(fieldsOf({ name: value })).toEqual(['name']);
  });

  it.each(['address', 'time', 'holiday'])(
    'DD-STOCKIST-034 %s も改行を拒む',
    (field) => {
      expect(fieldsOf({ [field]: 'a\nb' })).toEqual([field]);
    },
  );

  it('DD-STOCKIST-034 前後の空白は取り除いて通し、空白だけの値は拒む', () => {
    const parsed = stockistWriteSchema.safeParse({ ...validBody, name: '  本店  ' });
    expect(parsed.success && parsed.data.name).toBe('本店');
    expect(fieldsOf({ name: '   ' })).toEqual(['name']);
  });

  it.each([
    ['name', 255],
    ['address', 500],
    ['time', 120],
    ['holiday', 120],
  ])('DD-STOCKIST-034 %s は %i 字まで通し、1 字超えると拒む', (field, max) => {
    expect(fieldsOf({ [field]: 'a'.repeat(max as number) })).toEqual([]);
    expect(fieldsOf({ [field]: 'a'.repeat((max as number) + 1) })).toEqual([field]);
  });
});

describe('stockistWriteSchema の電話', () => {
  it.each(['03-1234-5678', '+81 3 1234 5678', '（03）1234-5678', '03\u30001234', '(03) 1234-5678'])(
    'DD-STOCKIST-034 電話 %j は通す',
    (phone) => {
      expect(fieldsOf({ phone })).toEqual([]);
    },
  );

  it.each([
    ['英字', 'call-me-maybe'],
    ['漢字の補足', '03-1234-5678（代表）'],
    ['途中の改行', '03-1234-5678\n03-0000-0000'],
    ['タブ', '03\t1234'],
    ['ゼロ幅空白', '03\u200b1234'],
    ['行区切り', '03\u20281234'],
  ])('DD-STOCKIST-034 電話に%sを含むと拒む', (_label, phone) => {
    expect(fieldsOf({ phone })).toEqual(['phone']);
  });

  it('DD-STOCKIST-034 電話は 50 字まで通し、51 字で拒む', () => {
    expect(fieldsOf({ phone: '1'.repeat(50) })).toEqual([]);
    expect(fieldsOf({ phone: '1'.repeat(51) })).toEqual(['phone']);
  });
});

describe('toInvalidStockistResponse', () => {
  it('DD-STOCKIST-034 誤りのあった項目の名前だけを重複なしで固定の本文に入れる', async () => {
    const parsed = stockistWriteSchema.safeParse({
      ...validBody,
      name: '本店\nInjected',
      phone: 'x'.repeat(60),
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const response = toInvalidStockistResponse(parsed.error);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Invalid request', fields: ['name', 'phone'] });
  });

  it('DD-STOCKIST-034 details・fieldErrors・formErrors・入力の値を本文に含めない', async () => {
    const parsed = stockistWriteSchema.safeParse({ ...validBody, name: '秘密の店名\nX' });
    if (parsed.success) throw new Error('unexpected success');

    const text = JSON.stringify(await toInvalidStockistResponse(parsed.error).json());

    expect(text).not.toMatch(/details|fieldErrors|formErrors/);
    expect(text).not.toContain('秘密の店名');
  });

  it('DD-STOCKIST-034 本文が配列などで項目の名前が無い時は fields を空にする', async () => {
    const parsed = stockistWriteSchema.safeParse([]);
    if (parsed.success) throw new Error('unexpected success');

    expect(await toInvalidStockistResponse(parsed.error).json()).toEqual({
      error: 'Invalid request',
      fields: [],
    });
  });
});
