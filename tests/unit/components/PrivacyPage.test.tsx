import React from 'react';
import { render } from '@testing-library/react';

// 設定を request 時に読むため、ページは await connection() の後で設定を読む（ビルド時に DB へ行かない）。
// connection と設定の読み出しは、呼ばれた順を記録する差し替えにする
const calls: string[] = [];
const mockConnection = jest.fn(async () => {
  calls.push('connection');
});
jest.mock('next/server', () => ({
  connection: () => mockConnection(),
}));
jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));

jest.mock('server-only', () => ({}), { virtual: true });
const mockServiceClient = { rpc: jest.fn() };
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));
const mockGetDeliveryTrackingSettings = jest.fn();
jest.mock('@/lib/orders/tracking/delivery-store', () => ({
  getDeliveryTrackingSettings: (...args: unknown[]) => mockGetDeliveryTrackingSettings(...args),
}));

import PrivacyPage from '@/app/privacy/page';

const OUTSOURCING_SENTENCE =
  '配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）';

function settings(enabled: boolean) {
  return { enabled, updatedAt: null, updatedByEmail: null, backfillCount: 0 };
}

/** async の Server Component を呼んで、出てきた要素を描いた HTML にする */
async function renderPage(): Promise<string> {
  const element = await PrivacyPage();
  const { container } = render(element);
  return container.innerHTML;
}

beforeEach(() => {
  calls.length = 0;
  mockConnection.mockClear();
  mockCreateServiceRoleClient.mockReset();
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  mockGetDeliveryTrackingSettings.mockReset();
  mockGetDeliveryTrackingSettings.mockImplementation(async () => {
    calls.push('settings');
    return settings(false);
  });
});

describe('プライバシーポリシーの委託先の一覧（グループ E-4 設計書 15）', () => {
  test('privacyの17TRACKの一文はONだけ', async () => {
    const offHtml = await renderPage();
    mockGetDeliveryTrackingSettings.mockImplementation(async () => settings(true));
    const onHtml = await renderPage();

    expect(offHtml).not.toContain('配送状況の確認業務');
    expect(offHtml).not.toContain('17TRACK');
    expect(onHtml).toContain(OUTSOURCING_SENTENCE);
  });

  test('ONの一文は「5. 個人情報の取扱いの委託」の一覧の項目として出し、今の3項目は残す', async () => {
    mockGetDeliveryTrackingSettings.mockImplementation(async () => settings(true));
    const element = await PrivacyPage();
    const { getByRole, getByText } = render(element);

    const section = getByRole('heading', { name: '5. 個人情報の取扱いの委託' }).closest('section') as HTMLElement;
    const items = Array.from(section.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toEqual([
      '商品の配送業務（配送事業者）',
      OUTSOURCING_SENTENCE,
      '決済処理業務（Stripe, Inc.）',
      'サーバー及びシステムの運用・保守業務',
    ]);
    expect(getByText(OUTSOURCING_SENTENCE).tagName).toBe('LI');
  });

  test('OFFの一覧は今の3項目のまま', async () => {
    const element = await PrivacyPage();
    const { getByRole } = render(element);

    const section = getByRole('heading', { name: '5. 個人情報の取扱いの委託' }).closest('section') as HTMLElement;
    expect(Array.from(section.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      '商品の配送業務（配送事業者）',
      '決済処理業務（Stripe, Inc.）',
      'サーバー及びシステムの運用・保守業務',
    ]);
  });

  test('connection() の後に設定を読む（ビルド時に DB へ行かず、request 時の設定を反映する）', async () => {
    await renderPage();

    expect(calls).toEqual(['connection', 'settings']);
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mockGetDeliveryTrackingSettings).toHaveBeenCalledWith(mockServiceClient);
  });

  test('17TRACK の鍵が無くても、設定がONなら委託の一文を出す（出す条件は設定のON）', async () => {
    const original = process.env.TRACKING_17TRACK_API_KEY;
    delete process.env.TRACKING_17TRACK_API_KEY;
    mockGetDeliveryTrackingSettings.mockImplementation(async () => settings(true));

    try {
      expect(await renderPage()).toContain(OUTSOURCING_SENTENCE);
    } finally {
      if (original !== undefined) process.env.TRACKING_17TRACK_API_KEY = original;
    }
  });

  test('設定を読めない時は、一文を黙って出し分けずにページの失敗として扱う', async () => {
    mockGetDeliveryTrackingSettings.mockRejectedValue(new Error('settings unavailable'));

    await expect(PrivacyPage()).rejects.toThrow('settings unavailable');
  });

  test('service_role の client を作れない時も、ページの失敗として扱う', async () => {
    mockCreateServiceRoleClient.mockRejectedValue(new Error('no service role'));

    await expect(PrivacyPage()).rejects.toThrow('no service role');
    expect(mockGetDeliveryTrackingSettings).not.toHaveBeenCalled();
  });

  test('ほかの節の文言は変えない（個人情報の国外移転・問い合わせ窓口）', async () => {
    const html = await renderPage();

    expect(html).toContain('7. 個人情報の国外移転');
    expect(html).toContain('privacy@lefildesheures.com');
    expect(html).toContain('最終改定日：2026年7月11日');
  });
});
