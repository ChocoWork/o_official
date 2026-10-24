/**
 * PRIVACY の委託の一覧の出し分け（STATE-PRIVACY-001: オフ・オン・読めない）を確かめる結合テスト。
 * `PrivacyPage` と設定の読み出し `getDeliveryTrackingSettings` を実物で使い、RPC の応答を変えて3状態と遷移を見る。
 * next/server の connection、next/link、service role の client の作成（RPC を持つ偽の client を返す）だけを差し替える。
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  connection: jest.fn(async () => undefined),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const mockRpc = jest.fn();
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));

import PrivacyPage from '@/app/privacy/page';

const CLAUSE =
  '配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）';

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    data: [{ enabled: false, updated_at: null, updated_by_email: null, backfill_count: 0, ...overrides }],
    error: null,
  };
}

async function renderAndListOutsourcing(): Promise<string[]> {
  const { unmount } = render(await PrivacyPage());
  const section = screen.getByRole('heading', { level: 2, name: '5. 個人情報の取扱いの委託' }).closest('section') as HTMLElement;
  const items = within(section).getAllByRole('listitem').map((li) => li.textContent ?? '');
  unmount();
  return items;
}

beforeEach(() => {
  mockRpc.mockReset();
  mockCreateServiceRoleClient.mockReset();
  mockCreateServiceRoleClient.mockResolvedValue({ rpc: (...args: unknown[]) => mockRpc(...args) });
});

describe('PRIVACY の委託の一覧の出し分け', () => {
  it('STATE-PRIVACY-001 オフ（enabled が false）は3項目で、17TRACK の字は頁のどこにも無い', async () => {
    mockRpc.mockResolvedValue(settingsRow({ enabled: false }));

    const { container } = render(await PrivacyPage());

    expect(mockRpc).toHaveBeenCalledWith('get_delivery_tracking_settings', undefined);
    const section = screen.getByRole('heading', { level: 2, name: '5. 個人情報の取扱いの委託' }).closest('section') as HTMLElement;
    expect(within(section).getAllByRole('listitem')).toHaveLength(3);
    expect(container.textContent).not.toContain('17TRACK');
  });

  it('STATE-PRIVACY-001 オン（enabled が true）は4項目で、2番目に 17TRACK の一文が入り、ほかの3項目は同じ順で残る', async () => {
    mockRpc.mockResolvedValue(settingsRow({ enabled: true }));

    expect(await renderAndListOutsourcing()).toEqual([
      '商品の配送業務（配送事業者）',
      CLAUSE,
      '決済処理業務（Stripe, Inc.）',
      'サーバー及びシステムの運用・保守業務',
    ]);
  });

  it('STATE-PRIVACY-001 一文の有無は enabled だけで決まり、更新者や遡りの件数が付いていても変わらない', async () => {
    mockRpc.mockResolvedValue(
      settingsRow({ enabled: false, updated_at: '2026-10-22T01:02:03.000Z', updated_by_email: 'owner@example.com', backfill_count: 12 }),
    );
    expect(await renderAndListOutsourcing()).toHaveLength(3);

    mockRpc.mockResolvedValue(settingsRow({ enabled: true, backfill_count: 0 }));
    expect(await renderAndListOutsourcing()).toHaveLength(4);
  });

  it('STATE-PRIVACY-001 オフからオン、オンからオフへの切り替えは、次の request で読み直した時から一覧に出る', async () => {
    mockRpc.mockResolvedValue(settingsRow({ enabled: false }));
    expect(await renderAndListOutsourcing()).not.toContain(CLAUSE);

    mockRpc.mockResolvedValue(settingsRow({ enabled: true }));
    expect(await renderAndListOutsourcing()).toContain(CLAUSE);

    mockRpc.mockResolvedValue(settingsRow({ enabled: false }));
    expect(await renderAndListOutsourcing()).not.toContain(CLAUSE);
    expect(mockRpc).toHaveBeenCalledTimes(3);
  });

  it('STATE-PRIVACY-001 どの状態でも最終改定日は変わらない', async () => {
    for (const enabled of [false, true]) {
      mockRpc.mockResolvedValue(settingsRow({ enabled }));
      const { container, unmount } = render(await PrivacyPage());
      expect(container).toHaveTextContent('最終改定日：2026年7月11日');
      unmount();
    }
  });

  it('STATE-PRIVACY-001 読めない時（関数が error を返した）は、オフの一覧を黙って出さずに頁の失敗になる', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } });

    await expect(PrivacyPage()).rejects.toThrow(/get_delivery_tracking_settings/);
  });

  it('STATE-PRIVACY-001 読めない状態は保存されず、次の request で読めればオンの一覧に戻る', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    await expect(PrivacyPage()).rejects.toThrow(/get_delivery_tracking_settings/);

    mockRpc.mockResolvedValue(settingsRow({ enabled: true }));
    expect(await renderAndListOutsourcing()).toContain(CLAUSE);
  });
});
