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

import PrivacyPage, { generateMetadata } from '@/app/privacy/page';

const OUTSOURCING_SENTENCE =
  '配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）';

function settings(enabled: boolean, updatedAt: string | null = null) {
  return { enabled, updatedAt, updatedByEmail: null, backfillCount: 0 };
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
  test('DD-PRIVACY-001 privacyの17TRACKの一文はONだけ', async () => {
    const offHtml = await renderPage();
    mockGetDeliveryTrackingSettings.mockImplementation(async () => settings(true));
    const onHtml = await renderPage();

    expect(offHtml).not.toContain('配送状況の確認業務');
    expect(offHtml).not.toContain('17TRACK');
    expect(onHtml).toContain(OUTSOURCING_SENTENCE);
  });

  test('DD-PRIVACY-001 ONの一文は「5. 個人情報の取扱いの委託」の一覧の項目として出し、今の3項目は残す', async () => {
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

  test('DD-PRIVACY-001 OFFの一覧は今の3項目のまま', async () => {
    const element = await PrivacyPage();
    const { getByRole } = render(element);

    const section = getByRole('heading', { name: '5. 個人情報の取扱いの委託' }).closest('section') as HTMLElement;
    expect(Array.from(section.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      '商品の配送業務（配送事業者）',
      '決済処理業務（Stripe, Inc.）',
      'サーバー及びシステムの運用・保守業務',
    ]);
  });

  test('DD-PRIVACY-001 connection() の後に設定を読む（ビルド時に DB へ行かず、request 時の設定を反映する）', async () => {
    await renderPage();

    expect(calls).toEqual(['connection', 'settings']);
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mockGetDeliveryTrackingSettings).toHaveBeenCalledWith(mockServiceClient);
  });

  test('DD-PRIVACY-001 17TRACK の鍵が無くても、設定がONなら委託の一文を出す（出す条件は設定のON）', async () => {
    const original = process.env.TRACKING_17TRACK_API_KEY;
    delete process.env.TRACKING_17TRACK_API_KEY;
    mockGetDeliveryTrackingSettings.mockImplementation(async () => settings(true));

    try {
      expect(await renderPage()).toContain(OUTSOURCING_SENTENCE);
    } finally {
      if (original !== undefined) process.env.TRACKING_17TRACK_API_KEY = original;
    }
  });

  test('DD-PRIVACY-001 設定を読めない時は、一文を黙って出し分けずにページの失敗として扱う', async () => {
    mockGetDeliveryTrackingSettings.mockRejectedValue(new Error('settings unavailable'));

    await expect(PrivacyPage()).rejects.toThrow('settings unavailable');
  });

  test('DD-PRIVACY-001 service_role の client を作れない時も、ページの失敗として扱う', async () => {
    mockCreateServiceRoleClient.mockRejectedValue(new Error('no service role'));

    await expect(PrivacyPage()).rejects.toThrow('no service role');
    expect(mockGetDeliveryTrackingSettings).not.toHaveBeenCalled();
  });

  test('DD-PRIVACY-001 ほかの節の文言は変えない（個人情報の国外移転・問い合わせ窓口）', async () => {
    const html = await renderPage();

    expect(html).toContain('7. 個人情報の国外移転');
    expect(html).toContain('privacy@lefildesheures.com');
    expect(html).toContain('最終改定日：2026年10月26日');
  });

  test('DD-PRIVACY-001 connection() が投げた時は、ページの失敗として扱い、client も作らず設定も読まない', async () => {
    mockConnection.mockImplementationOnce(async () => {
      throw new Error('connection failed');
    });

    await expect(PrivacyPage()).rejects.toThrow('connection failed');
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockGetDeliveryTrackingSettings).not.toHaveBeenCalled();
  });

  test('DD-PRIVACY-001 generateMetadata が title・description・og:title・og:description・og:image を返す', async () => {
    const metadata = await generateMetadata();

    expect(metadata.title).toBe('Privacy Policy | Le Fil des Heures');
    expect(metadata.description).toBe(
      'Le Fil des Heures のプライバシーポリシー。個人情報の取扱い、利用目的、第三者提供、お問い合わせ窓口をご案内します。',
    );
    expect(metadata.openGraph?.title).toBe(metadata.title);
    expect(metadata.openGraph?.description).toBe(metadata.description);
    expect(metadata.openGraph?.images).toEqual(['/mainphoto.png']);
  });

  test('DD-PRIVACY-001 h1 と13の h2 が決まった順で並び、窓口のメールはリンクにせず、お問い合わせフォームは /contact へ向く', async () => {
    const element = await PrivacyPage();
    const { container, getByRole, getByText } = render(element);

    expect(getByRole('heading', { level: 1 }).textContent).toBe('Privacy Policy / 個人情報の取り扱いについて');
    expect(Array.from(container.querySelectorAll('h2')).map((h) => h.textContent?.trim())).toEqual([
      '個人情報の取り扱いについて',
      '1. 個人情報の定義',
      '2. 個人情報の収集方法',
      '3. 個人情報の利用目的',
      '4. 個人情報の第三者提供',
      '5. 個人情報の取扱いの委託',
      '6. 個人情報の保有期間',
      '7. 個人情報の国外移転',
      '8. 個人情報の安全管理',
      '9. Cookie 及び外部サービスの利用',
      '10. 保有個人データの開示・訂正・利用停止等の請求',
      '11. 本ポリシーの変更',
      '12. お問い合わせ窓口',
    ]);

    expect(getByText('お問い合わせ先：privacy@lefildesheures.com').tagName).toBe('LI');
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(getByRole('link', { name: 'お問い合わせフォーム' }).getAttribute('href')).toBe('/contact');
    expect(container.textContent).toContain('制定日：2026年6月20日');
  });

  test('DD-PRIVACY-001 最終改定日は、追跡の設定を切り替えていない（updatedAt が null）間は基準日の 2026年10月26日', async () => {
    mockGetDeliveryTrackingSettings.mockImplementation(async () => settings(false, null));

    expect(await renderPage()).toContain('最終改定日：2026年10月26日');
  });

  test('DD-PRIVACY-001 最終改定日は、追跡の設定を切り替えた日（日本時間）に追従する', async () => {
    mockGetDeliveryTrackingSettings.mockImplementation(async () => settings(true, '2026-10-26T16:30:00Z'));

    const html = await renderPage();

    expect(html).toContain('最終改定日：2026年10月27日');
    expect(html).not.toContain('最終改定日：2026年10月26日');
  });
});
