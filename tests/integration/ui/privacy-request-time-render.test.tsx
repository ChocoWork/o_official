/**
 * PRIVACY `/privacy` が request のたびに描き、service role で設定を読み、読めない時は頁を失敗にすること（ARC-PRIVACY-001）を確かめる結合テスト。
 *
 * 頁本体・`createServiceRoleClient`・配送の追跡の部品（delivery-store）は実物を通し、
 * 差し替えるのは Next.js の `connection`、`@supabase/supabase-js` の client（rpc の返事を決める）、next/link だけにする。
 */
import React from 'react';
import { render } from '@testing-library/react';

const calls: string[] = [];
const mockConnection = jest.fn(async () => {
  calls.push('connection');
});
jest.mock('next/server', () => ({
  connection: () => mockConnection(),
}));
jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
jest.mock('server-only', () => ({}), { virtual: true });

const mockRpc = jest.fn();
const mockCreateClient = jest.fn((..._args: unknown[]) => {
  calls.push('client');
  return { rpc: mockRpc };
});
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

import * as privacyModule from '@/app/privacy/page';
import PrivacyPage from '@/app/privacy/page';

const OUTSOURCING_SENTENCE =
  '配送状況の確認業務（配送追跡サービス 17TRACK。配送事業者名と伝票番号のみを提供し、お名前・ご住所・ご連絡先は提供しません）';

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    updated_at: null,
    updated_by_email: null,
    backfill_count: 0,
    ...overrides,
  };
}

function answerWith(data: unknown) {
  mockRpc.mockImplementation(async () => {
    calls.push('rpc');
    return { data, error: null };
  });
}

async function renderPage() {
  const element = await PrivacyPage();
  return render(element);
}

describe('PRIVACY の頁を request のたびに描く作り', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    calls.length = 0;
    mockConnection.mockClear();
    mockCreateClient.mockClear();
    mockRpc.mockReset();
    process.env.SUPABASE_URL = 'https://example.supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-for-test';
    answerWith([settingsRow()]);
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('ARC-PRIVACY-001 初めに connection を待ち、その後で client を作って設定を読む（ビルドの時に DB へ行かない）', async () => {
    await renderPage();

    expect(calls).toEqual(['connection', 'client', 'rpc']);
  });

  it('ARC-PRIVACY-001 connection の返事を待つ間は DB に触れず、返事の後で client と rpc が動く', async () => {
    let release: () => void = () => undefined;
    mockConnection.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            calls.push('connection');
            resolve();
          };
        }),
    );

    const pending = PrivacyPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();

    release();
    await pending;
    expect(calls).toEqual(['connection', 'client', 'rpc']);
  });

  it('ARC-PRIVACY-001 request のたびに設定を読み直し、切り替えが次の描画へそのまま届く', async () => {
    answerWith([settingsRow({ enabled: false })]);
    const off = await renderPage();
    expect(off.container.innerHTML).not.toContain('17TRACK');
    off.unmount();

    answerWith([settingsRow({ enabled: true })]);
    const on = await renderPage();
    expect(on.container.innerHTML).toContain(OUTSOURCING_SENTENCE);
    on.unmount();

    answerWith([settingsRow({ enabled: false })]);
    const offAgain = await renderPage();
    expect(offAgain.container.innerHTML).not.toContain('17TRACK');

    expect(mockConnection).toHaveBeenCalledTimes(3);
    expect(mockRpc).toHaveBeenCalledTimes(3);
  });

  it('ARC-PRIVACY-001 頁のモジュールは静的な描画を固める指定を持たない（既定の書き出しと metadata を返す関数だけ）', () => {
    expect(privacyModule).not.toHaveProperty('revalidate');
    expect(privacyModule).not.toHaveProperty('dynamic');
    expect(privacyModule).not.toHaveProperty('generateStaticParams');
  });

  it('ARC-PRIVACY-001 設定は service role の鍵で作った client の rpc で読み、閲覧者の session を持ち込まない', async () => {
    await renderPage();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = mockCreateClient.mock.calls[0] as [string, string, Record<string, any>];
    expect(url).toBe('https://example.supabase.test');
    expect(key).toBe('service-role-key-for-test');
    expect(options.auth).toMatchObject({ persistSession: false });
    expect(mockRpc).toHaveBeenCalledWith('get_delivery_tracking_settings', undefined);
  });

  it('ARC-PRIVACY-001 頁が使うのは enabled だけで、担当者のメールや件数は頁に出ない', async () => {
    answerWith([
      settingsRow({
        enabled: true,
        updated_at: '2026-10-01T00:00:00.000Z',
        updated_by_email: 'owner-secret@example.com',
        backfill_count: 4321,
      }),
    ]);

    const { container } = await renderPage();

    expect(container.innerHTML).toContain(OUTSOURCING_SENTENCE);
    expect(container.innerHTML).not.toContain('owner-secret@example.com');
    expect(container.innerHTML).not.toContain('4321');
    expect(container.innerHTML).not.toContain('2026-10-01');
  });

  it('ARC-PRIVACY-001 17TRACK の鍵の有無は見ず、出し分けは設定の enabled だけで決まる', async () => {
    delete process.env.TRACKING_17TRACK_API_KEY;
    answerWith([settingsRow({ enabled: true })]);
    const withoutKey = await renderPage();
    expect(withoutKey.container.innerHTML).toContain(OUTSOURCING_SENTENCE);
    withoutKey.unmount();

    process.env.TRACKING_17TRACK_API_KEY = 'key-present';
    answerWith([settingsRow({ enabled: false })]);
    const withKey = await renderPage();
    expect(withKey.container.innerHTML).not.toContain('17TRACK');
  });

  it('ARC-PRIVACY-001 service role の鍵が無い時は client を作れず、頁の描画が失敗する', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(PrivacyPage()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('ARC-PRIVACY-001 DB の URL が無い時も client を作れず、頁の描画が失敗する', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    await expect(PrivacyPage()).rejects.toThrow(/SUPABASE_URL/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('ARC-PRIVACY-001 rpc が error を返した時は、一文を出し分けずに例外をそのまま出す', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } });

    await expect(PrivacyPage()).rejects.toThrow(/get_delivery_tracking_settings/);
  });

  it('ARC-PRIVACY-001 rpc が投げた時も、頁の描画が失敗する', async () => {
    mockRpc.mockRejectedValue(new Error('network down'));

    await expect(PrivacyPage()).rejects.toThrow(/get_delivery_tracking_settings/);
  });

  it('ARC-PRIVACY-001 設定の返り値が読めない形の時は、黙って OFF 扱いにせず頁の描画が失敗する', async () => {
    answerWith([]);

    await expect(PrivacyPage()).rejects.toThrow(/get_delivery_tracking_settings/);
  });

  it('ARC-PRIVACY-001 connection が失敗した時は、client も作らず設定も読まずに頁の描画が失敗する', async () => {
    mockConnection.mockImplementationOnce(async () => {
      throw new Error('connection failed');
    });

    await expect(PrivacyPage()).rejects.toThrow('connection failed');
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
