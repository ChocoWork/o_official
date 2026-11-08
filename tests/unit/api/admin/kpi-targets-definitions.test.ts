jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn().mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin' }),
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
  })),
}));

import { GET } from '@/app/api/admin/kpi/targets/route';

type Definition = { key: string; label: string; definition: string };

async function definitions(): Promise<Definition[]> {
  const response = (await GET(new Request('http://localhost/api/admin/kpi/targets'))) as unknown as {
    status: number;
    body: { data: { definitions: Definition[] } };
  };
  expect(response.status).toBe(200);
  return response.body.data.definitions;
}

describe('GET /api/admin/kpi/targets の定義の文', () => {
  it('FREQ-572-AC-01: 目標の鍵 sales の名前と定義が「受注高」になり、鍵は変わらない', async () => {
    const sales = (await definitions()).find((item) => item.key === 'sales');

    expect(sales).toEqual({
      key: 'sales',
      label: '受注高',
      definition: '支払いを受けた注文の額 − 出荷前の取り消し',
      priority: '◎',
    });
  });

  it('FREQ-572-AC-01: 客単価の定義は「受注高 ÷ 注文数」で、広告の売上（ROAS）の定義は変えない', async () => {
    const all = await definitions();

    expect(all.find((item) => item.key === 'aov')?.definition).toBe('受注高 ÷ 注文数');
    expect(all.find((item) => item.key === 'roas')?.definition).toBe('売上 ÷ 広告費');
    expect(all.map((item) => item.definition).join('\n')).not.toContain('総売上');
  });
});
