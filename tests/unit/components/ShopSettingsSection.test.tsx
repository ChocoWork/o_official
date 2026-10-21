import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ShopSettingsSection from '@/components/ShopSettingsSection';
import { clientFetch } from '@/lib/client-fetch';
import type { ShopSettingToggle, ShopSettings } from '@/lib/orders/refund/refund-types';
import type { DeliveryTrackingSettings } from '@/lib/orders/tracking/delivery-types';
import { buildShopReturnSettings } from './shop-return-settings-test-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));

const mockedFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const SETTINGS_URL = '/api/admin/settings/shop';
const AUTO_REFUND_NAME = '取り消した注文に届いた入金を、自動で全額返金する';
const AUTO_CANCEL_NAME = '支払額が注文と違う注文を、自動で全額返金して取り消す';
const AUTO_CANCEL_CONFIRM =
  'オンにすると、支払額が注文と違う注文は、差が小さくても自動で全額返金して取り消されます。オンにしますか？';
const LOAD_FAILED = 'ショップの設定を読み込めませんでした。';
const SAVE_FAILED = 'ショップの設定を保存できませんでした。';
const SAVED = '設定を保存しました。';
/** 日本時間では 2026/10/11 10:30 */
const CHANGED_AT = '2026-10-11T01:30:00.000Z';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 画面と同じ書き方の日本時間 */
function screenTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** 窓口の答え。既定は ①オン・②オフで、どちらもまだ誰も変えていない */
function settings(
  overrides: { autoRefund?: Partial<ShopSettingToggle>; autoCancel?: Partial<ShopSettingToggle> } = {},
): ShopSettings {
  return {
    autoRefundCancelledOrderPayment: { enabled: true, updatedAt: null, updatedByEmail: null, ...overrides.autoRefund },
    autoCancelAmountMismatch: { enabled: false, updatedAt: null, updatedByEmail: null, ...overrides.autoCancel },
  };
}

/** 画面を開き、設定を読み終えるまで待つ */
async function renderLoaded(loaded: ShopSettings = settings()) {
  mockedFetch.mockResolvedValueOnce(json({ data: loaded }));
  render(<ShopSettingsSection />);
  await screen.findByRole('switch', { name: AUTO_REFUND_NAME });
}

const autoRefundSwitch = () => screen.getByRole('switch', { name: AUTO_REFUND_NAME });
const autoCancelSwitch = () => screen.getByRole('switch', { name: AUTO_CANCEL_NAME });

/** 窓口へ PUT した呼び出し */
function putCalls() {
  return mockedFetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
}

/** n 番目（0 始まり）の PUT が送った本文 */
function putBody(index = 0): Record<string, unknown> {
  return JSON.parse(String(putCalls()[index][1]?.body)) as Record<string, unknown>;
}

/** 窓口を呼んだ順に、GET か PUT かを並べる（読み込みの GET には method が付かない） */
function callOrder() {
  return mockedFetch.mock.calls.map(([, init]) => init?.method ?? 'GET');
}

/** 保存の直前の読み直し（GET）の答えを用意する。開く時の読み込みの答えは renderLoaded が用意する */
function serveReread(latest: ShopSettings = settings()) {
  mockedFetch.mockResolvedValueOnce(json({ data: latest }));
}

/** 保存の直前の読み直し（GET）の答えと、保存（PUT）の答えを、この順に用意する */
function serveSave(latest: ShopSettings, saved: ShopSettings) {
  serveReread(latest);
  mockedFetch.mockResolvedValueOnce(json({ data: saved }));
}

/**
 * 窓口の返事を止めておく。release(返事) で返す。返した直後に waitFor で画面の更新を待つ
 * （waitFor が act の外で待つので、返事の後の画面の更新が act の警告を出さない）
 */
function hold() {
  let release: (response: Response) => void = () => undefined;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('ShopSettingsSection の読み込み', () => {
  it('読み込みの間は「読み込み中です...」を出し、答えが届くとトグルに替わる', async () => {
    let answer: (response: Response) => void = () => undefined;
    mockedFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    render(<ShopSettingsSection />);

    expect(screen.getByRole('heading', { name: 'ショップの設定' })).toBeInTheDocument();
    expect(screen.getByText('読み込み中です...')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();

    answer(json({ data: settings() }));

    expect(await screen.findByRole('switch', { name: AUTO_REFUND_NAME })).toBeInTheDocument();
    expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument();
  });

  it('窓口を読み、題・欄の見出し・2つのトグルと説明を出す。最初の値は ①オン・②オフ', async () => {
    await renderLoaded();

    expect(mockedFetch).toHaveBeenCalledWith(SETTINGS_URL, { cache: 'no-store' });
    expect(screen.getByRole('heading', { name: 'ショップの設定' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '自動の返金' })).toBeInTheDocument();
    expect(autoRefundSwitch()).toBeChecked();
    expect(autoCancelSwitch()).not.toBeChecked();
    expect(
      screen.getByText('主にコンビニ払いで、期限切れで取り消した後に払われた時に動きます。お客様に返金のお知らせが届きます。'),
    ).toBeInTheDocument();
    expect(screen.getByText('オンにすると、差が小さくても注文は取り消されます。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each<[string, () => Promise<Response>]>([
    ['窓口が断った', () => Promise.resolve(json({ error: 'x', code: 'failed' }, 500))],
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['答えの形が違う', () => Promise.resolve(json({ data: { autoRefundCancelledOrderPayment: null } }))],
  ])('読み込めなかった時（%s）は、失敗の文を出し、トグルは出さない', async (_label, answer) => {
    mockedFetch.mockImplementationOnce(answer);

    render(<ShopSettingsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ショップの設定' })).toBeInTheDocument();
  });
});

describe('ShopSettingsSection の「最後に変えた人」', () => {
  it('まだ誰も変えていないトグルには「まだ変えていません」を出す', async () => {
    await renderLoaded();

    expect(screen.getByTestId('shop-setting-auto-refund-updated')).toHaveTextContent(/^まだ変えていません$/);
    expect(screen.getByTestId('shop-setting-auto-cancel-updated')).toHaveTextContent(/^まだ変えていません$/);
  });

  it('変えた人がいるトグルには「最後に変えた人: {メール}（{日本時間の日時}）」を、そのトグルの下だけに出す', async () => {
    await renderLoaded(settings({ autoRefund: { updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' } }));

    const line = screen.getByTestId('shop-setting-auto-refund-updated');
    expect(line).toHaveTextContent(`最後に変えた人: owner@example.com（${screenTime(CHANGED_AT)}）`);
    // 日本時間で出す（UTC の 01:30 は日本時間の 10:30）。試験をする場所の時刻に左右されない
    expect(line).toHaveTextContent('10:30');
    expect(screen.getByTestId('shop-setting-auto-cancel-updated')).toHaveTextContent(/^まだ変えていません$/);
  });

  it('時刻があってメールが空の時（変えた人のアカウントが消えている場合など）は「不明」と出す', async () => {
    await renderLoaded(settings({ autoCancel: { updatedAt: CHANGED_AT, updatedByEmail: null } }));

    expect(screen.getByTestId('shop-setting-auto-cancel-updated')).toHaveTextContent(
      `最後に変えた人: 不明（${screenTime(CHANGED_AT)}）`,
    );
  });
});

describe('ShopSettingsSection の①の切り替え', () => {
  it('①をオフにすると、保存の直前に読み直し、②の値と一緒に PUT で保存する。確かめは出さず、保存の答えで画面を置き換える', async () => {
    await renderLoaded();
    serveSave(
      settings(),
      settings({ autoRefund: { enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' } }),
    );

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    expect(mockedFetch).toHaveBeenNthCalledWith(2, SETTINGS_URL, { cache: 'no-store' });
    expect(putCalls()[0][0]).toBe(SETTINGS_URL);
    expect(putCalls()[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(SAVED);
    expect(screen.getByTestId('shop-setting-auto-refund-updated')).toHaveTextContent(
      `最後に変えた人: owner@example.com（${screenTime(CHANGED_AT)}）`,
    );
    expect(screen.getByTestId('shop-setting-auto-cancel-updated')).toHaveTextContent(/^まだ変えていません$/);
  });

  it('①をオフからオンにする時も、確かめを出さずに保存する', async () => {
    await renderLoaded(settings({ autoRefund: { enabled: false } }));
    serveSave(settings({ autoRefund: { enabled: false } }), settings({ autoRefund: { enabled: true } }));

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).toBeChecked());
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('②がオンのままの①の保存は、②の値（オン）をそのまま送る', async () => {
    await renderLoaded(settings({ autoCancel: { enabled: true } }));
    serveSave(
      settings({ autoCancel: { enabled: true } }),
      settings({ autoRefund: { enabled: false }, autoCancel: { enabled: true } }),
    );

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: true });
    expect(autoCancelSwitch()).toBeChecked();
  });

  it('保存の直前に読み直し、変えない方は読み直した値を送る。別のタブで②がオンになっていたら、それを送り、画面にも出す', async () => {
    await renderLoaded(); // 画面は ②オフ
    // 画面を開いた後に、別のタブで②がオンになった
    const turnedOnElsewhere = { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    serveSave(
      settings({ autoCancel: turnedOnElsewhere }),
      settings({
        autoRefund: { enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' },
        autoCancel: turnedOnElsewhere,
      }),
    );

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: true });
    expect(autoCancelSwitch()).toBeChecked();
    expect(screen.getByTestId('shop-setting-auto-cancel-updated')).toHaveTextContent('最後に変えた人: staff@example.com');
  });

  it('画面が②オンのままでも、読み直して②がオフなら、①の保存で②をオンに戻さない（確かめ無しでオンにしない）', async () => {
    await renderLoaded(settings({ autoCancel: { enabled: true } })); // 画面は ②オン
    // 画面を開いた後に、別のタブで②がオフになった
    const turnedOffElsewhere = { enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    serveSave(
      settings({ autoCancel: turnedOffElsewhere }),
      settings({
        autoRefund: { enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' },
        autoCancel: turnedOffElsewhere,
      }),
    );

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false });
    expect(autoCancelSwitch()).not.toBeChecked();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ShopSettingsSection の②をオンにする時の確かめ', () => {
  it('②をオフからオンにしようとすると、確かめの画面を出し、まだ保存しない。トグルはオフのまま', async () => {
    await renderLoaded();
    const toggle = autoCancelSwitch();

    fireEvent.click(toggle);

    const dialog = await screen.findByRole('dialog', { name: AUTO_CANCEL_NAME });
    expect(within(dialog).getByText(AUTO_CANCEL_CONFIRM)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'オンにする' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toBeEnabled();
    expect(toggle).not.toBeChecked();
    // 確かめの間は、読み直しも保存も呼ばない（呼んだのは、開く時の読み込みだけ）
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('「オンにする」で、保存の直前に読み直した①の値と一緒に保存し、確かめの画面を閉じて、②をオンにする。フォーカスは②のトグルへ戻る', async () => {
    await renderLoaded();
    // 画面の①はオンだが、保存の直前に読み直した①はオフ（別のタブで変えた）。保存は読み直した値を送る
    serveSave(
      settings({ autoRefund: { enabled: false } }),
      settings({
        autoRefund: { enabled: false },
        autoCancel: { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' },
      }),
    );
    const toggle = autoCancelSwitch();
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: AUTO_CANCEL_NAME });

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: true });
    expect(autoCancelSwitch()).toBeChecked();
    expect(autoRefundSwitch()).not.toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent(SAVED);
    expect(screen.getByTestId('shop-setting-auto-cancel-updated')).toHaveTextContent(
      `最後に変えた人: owner@example.com（${screenTime(CHANGED_AT)}）`,
    );
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('「やめる」では保存せずに閉じ、②はオフのまま。フォーカスは②のトグルへ戻る', async () => {
    await renderLoaded();
    const toggle = autoCancelSwitch();
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: AUTO_CANCEL_NAME });

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('Escape でも「やめる」と同じに、保存せずに閉じる', async () => {
    await renderLoaded();
    fireEvent.click(autoCancelSwitch());
    await screen.findByRole('dialog', { name: AUTO_CANCEL_NAME });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(autoCancelSwitch()).not.toBeChecked();
  });

  it('②をオンからオフにする時は、確かめを出さずに保存する', async () => {
    await renderLoaded(settings({ autoCancel: { enabled: true } }));
    serveSave(
      settings({ autoCancel: { enabled: true } }),
      settings({ autoCancel: { enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' } }),
    );

    fireEvent.click(autoCancelSwitch());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(autoCancelSwitch()).not.toBeChecked());
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: true, autoCancelAmountMismatch: false });
  });
});

describe('ShopSettingsSection の保存中', () => {
  it('保存している間にトグルを押しても、読み直しも保存も二重に送らず、確かめの画面も出さない。トグルは disabled にしないので、キーボードの場所（フォーカス）を失わない', async () => {
    await renderLoaded();
    serveReread();
    const { held, release } = hold();
    mockedFetch.mockImplementationOnce(() => held);
    const toggle = autoRefundSwitch();
    toggle.focus();
    const section = () => screen.getByRole('region', { name: 'ショップの設定' });

    fireEvent.click(toggle);

    // 押した直後（読み直しの答えを待つ間）から保存が済むまで、画面は「保存中」（aria-busy）。2つのトグルは disabled にしない:
    // disabled にすると、本物のブラウザはフォーカスを body へ移し、保存が済んでも戻らない（キーボードで続けて操作できなくなる）
    expect(section()).toHaveAttribute('aria-busy', 'true');
    expect(autoRefundSwitch()).toBeEnabled();
    expect(autoCancelSwitch()).toBeEnabled();
    expect(toggle).toHaveFocus();
    // 保存の間に押し直しても何も始めない。②を押しても確かめの画面は出ない（二重の保護は handleToggle の saving の判断だけ）
    fireEvent.click(autoRefundSwitch());
    fireEvent.click(autoCancelSwitch());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 読み直しの後に保存が出る（答えは止めてある）。押し直しても、読み直しも保存も増えない
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);

    release(json({ data: settings({ autoRefund: { enabled: false } }) }));

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(section()).toHaveAttribute('aria-busy', 'false');
    expect(toggle).toHaveFocus();
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('確かめの画面から保存している間は、2つのボタンを押せず、Escape でも閉じない。済むと閉じる', async () => {
    await renderLoaded();
    fireEvent.click(autoCancelSwitch());
    const dialog = await screen.findByRole('dialog', { name: AUTO_CANCEL_NAME });
    serveReread();
    const { held, release } = hold();
    mockedFetch.mockImplementationOnce(() => held);

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(within(dialog).getByRole('button', { name: 'オンにする' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'やめる' })).toBeDisabled();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: AUTO_CANCEL_NAME })).toBeInTheDocument();

    release(json({ data: settings({ autoCancel: { enabled: true } }) }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(autoCancelSwitch()).toBeChecked();
  });
});

describe('ShopSettingsSection の保存の失敗', () => {
  it.each<[string, () => Promise<Response>]>([
    ['500', () => Promise.resolve(json({ error: 'x', code: 'failed' }, 500))],
    ['403', () => Promise.resolve(json({ error: 'Forbidden' }, 403))],
    ['429', () => Promise.resolve(json({ error: 'Too many requests' }, 429))],
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('保存（PUT）できなかった時（%s）は、失敗の文を出し、トグルは元の値のまま。保存の知らせは出さない', async (_label, answer) => {
    await renderLoaded();
    serveReread();
    mockedFetch.mockImplementationOnce(answer);

    fireEvent.click(autoRefundSwitch());

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    expect(autoRefundSwitch()).toBeChecked();
    expect(autoRefundSwitch()).toBeEnabled();
    expect(autoCancelSwitch()).toBeEnabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('保存の直前の読み直しができなかった時は、保存の窓口を呼ばずに、失敗の文を出す', async () => {
    await renderLoaded();
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));

    fireEvent.click(autoRefundSwitch());

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(putCalls()).toHaveLength(0);
    expect(autoRefundSwitch()).toBeChecked();
    expect(autoRefundSwitch()).toBeEnabled();
    expect(autoCancelSwitch()).toBeEnabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('確かめの画面から保存できなかった時も、画面を閉じて失敗の文を出し、②はオフのまま', async () => {
    await renderLoaded();
    serveReread();
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    fireEvent.click(autoCancelSwitch());
    const dialog = await screen.findByRole('dialog', { name: AUTO_CANCEL_NAME });

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(autoCancelSwitch()).not.toBeChecked();
    expect(autoCancelSwitch()).toBeEnabled();
  });

  it('失敗の後にもう一度保存できると、失敗の文は消えて、保存の知らせが出る', async () => {
    await renderLoaded();
    serveReread();
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    fireEvent.click(autoRefundSwitch());
    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    serveSave(settings(), settings({ autoRefund: { enabled: false } }));

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(autoRefundSwitch()).not.toBeChecked();
    expect(putCalls()).toHaveLength(2);
  });
});

describe('ShopSettingsSection の送り方', () => {
  it('保存は clientFetch を通るので、PUT に CSRF の印（x-csrf-token）が付き、読み込み・読み直しの GET には付かない', async () => {
    // この1本だけ本物の clientFetch を通し、その先の fetch と cookie を差し替える
    const { clientFetch: realClientFetch } = jest.requireActual<typeof import('@/lib/client-fetch')>('@/lib/client-fetch');
    const originalFetch = global.fetch;
    const rawFetch = jest.fn(async (_url: string, init?: RequestInit) =>
      json({ data: init?.method === 'PUT' ? settings({ autoRefund: { enabled: false } }) : settings() }),
    );
    Object.defineProperty(global, 'fetch', { value: rawFetch, writable: true, configurable: true });
    const cookie = jest.spyOn(document, 'cookie', 'get').mockReturnValue('foo=bar; sb-csrf-token=csrf-token-value');
    mockedFetch.mockImplementation(realClientFetch);

    try {
      render(<ShopSettingsSection />);
      fireEvent.click(await screen.findByRole('switch', { name: AUTO_REFUND_NAME }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));

      const gets = rawFetch.mock.calls.filter(([, init]) => init?.method === 'GET');
      const put = rawFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(gets).toHaveLength(2); // 開く時の読み込みと、保存の直前の読み直し
      expect((put?.[1]?.headers as Headers).get('x-csrf-token')).toBe('csrf-token-value');
      for (const [, init] of gets) {
        expect((init?.headers as Headers).get('x-csrf-token')).toBeNull();
      }
    } finally {
      cookie.mockRestore();
      Object.defineProperty(global, 'fetch', { value: originalFetch, writable: true, configurable: true });
    }
  });
});

// ここから下は、グループ E-3 の Task 12（ショップの設定の「返品」の欄）で足した試験。窓口の答えに返品の設定（returns）が付く

/** 返品の設定が付いた窓口の答え。形の違う returns も渡せるよう unknown にする */
type AnswerWithReturns = ShopSettings & { returns?: unknown };

function withReturns(returns: unknown = buildShopReturnSettings(), toggles: ShopSettings = settings()): AnswerWithReturns {
  return { ...toggles, returns };
}

const RETURN_ADDRESS = {
  name: '返品係 山田',
  postalCode: '150-0001',
  address: '東京都渋谷区神宮前1-2-3',
  phone: '03-1234-5678',
};

const SAVE_RETURNS_LABEL = '保存する';
const PRESSED_WHILE_SAVING = '保存の最中です。済んでから、もう一度「保存する」を押してください。';
const saveReturnsButton = () => screen.getByRole('button', { name: SAVE_RETURNS_LABEL });
const regionOf = (name: string) => screen.getByRole('region', { name });
const changeField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** 理由ごとの行の1つ目（破損・不良）だけを書き換えた返品の設定。形の違う答えの試験に使う */
function withFirstReason(changes: Record<string, unknown>): unknown {
  const base = buildShopReturnSettings();
  return { ...base, reasons: base.reasons.map((row, index) => (index === 0 ? { ...row, ...changes } : row)) };
}

describe('ShopSettingsSection の返品の欄の読み込み', () => {
  it('答えに返品の設定があると、自動の返金の下に「返品」の欄を出し、保存してある値を入れる', async () => {
    await renderLoaded(withReturns(buildShopReturnSettings({ returnAddress: RETURN_ADDRESS, windowDays: 14 })));

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['自動の返金', '返品']);
    expect(screen.getByLabelText('名前')).toHaveValue(RETURN_ADDRESS.name);
    expect(screen.getByLabelText('日数')).toHaveValue('14');
    // 自動の返金の2つは今までどおり
    expect(autoRefundSwitch()).toBeChecked();
    expect(autoCancelSwitch()).not.toBeChecked();
  });

  it('答えに返品の設定が無い（E-2 の窓口の形の）時は、返品の欄を出さず、自動の返金の2つだけを出す', async () => {
    await renderLoaded();

    expect(screen.queryByRole('heading', { name: '返品' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SAVE_RETURNS_LABEL })).not.toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['理由が1つ足りない', { ...buildShopReturnSettings(), reasons: buildShopReturnSettings().reasons.slice(0, 9) }],
    ['最後に変えた人の形が違う', { ...buildShopReturnSettings(), updated: { ...buildShopReturnSettings().updated, fees: null } }],
    ['日数が文字', { ...buildShopReturnSettings(), windowDays: '7' }],
    ['申し込みの受付が真偽でない', { ...buildShopReturnSettings(), requestsEnabled: 'yes' }],
    ['申し込みの種類が知らない値', { ...buildShopReturnSettings(), requestTypes: 'everything' }],
    ['注意書きが文字でない', { ...buildShopReturnSettings(), noticeText: null }],
    ['注意書きの欄が無い（段1の形）', { ...buildShopReturnSettings(), noticeText: undefined }],
    ['理由の「出す」が真偽でない', withFirstReason({ shown: 'yes' })],
    ['理由のご希望が知らない値', withFirstReason({ resolutions: 'both' })],
    ['理由の写真の決まりが知らない値', withFirstReason({ photo: 'always' })],
    ['理由の写真の案内の文が文字でない', withFirstReason({ photoInstructions: null })],
  ])('返品の設定の形が違う時（%s）は、読み込めなかった旨を出し、トグルも返品の欄も出さない', async (_label, returns) => {
    mockedFetch.mockResolvedValueOnce(json({ data: withReturns(returns) }));

    render(<ShopSettingsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '返品' })).not.toBeInTheDocument();
  });
});

describe('ShopSettingsSection の返品の欄の保存', () => {
  it('「保存する」で、保存の直前に読み直し、自動の返金の2つは読み直した値と一緒に PUT する。済むと窓口が返した値と最後に変えた人を出す', async () => {
    await renderLoaded(withReturns());
    // 画面を開いた後に、別のタブで②がオンになった。保存は読み直した値を送り、②をオフに戻さない
    const turnedOnElsewhere = { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    const saved = buildShopReturnSettings({
      returnAddress: RETURN_ADDRESS,
      updated: { ...buildShopReturnSettings().updated, shipping: { at: CHANGED_AT, byEmail: 'owner@example.com' } },
    });
    serveSave(settings({ autoCancel: turnedOnElsewhere }), withReturns(saved, settings({ autoCancel: turnedOnElsewhere })));
    changeField('名前', RETURN_ADDRESS.name);
    changeField('郵便番号', RETURN_ADDRESS.postalCode);
    changeField('住所', RETURN_ADDRESS.address);
    changeField('電話番号', RETURN_ADDRESS.phone);

    fireEvent.click(saveReturnsButton());

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    expect(mockedFetch).toHaveBeenNthCalledWith(2, SETTINGS_URL, { cache: 'no-store' });
    expect(putCalls()[0][0]).toBe(SETTINGS_URL);
    expect(putCalls()[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    const body = putBody();
    expect(Object.keys(body).sort()).toEqual(['autoCancelAmountMismatch', 'autoRefundCancelledOrderPayment', 'returns']);
    expect(body.autoRefundCancelledOrderPayment).toBe(true);
    expect(body.autoCancelAmountMismatch).toBe(true);
    expect(body.returns).toMatchObject({ returnAddress: RETURN_ADDRESS, windowDays: 7, customerPaidMethod: 'customer_ships' });
    // 窓口が返した値で画面を置き換える
    expect(autoCancelSwitch()).toBeChecked();
    expect(
      within(regionOf('返送')).getByText(`最後に変えた人: owner@example.com（${screenTime(CHANGED_AT)}）`),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('名前')).toHaveValue(RETURN_ADDRESS.name);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('入力に誤りがある時は、読み直しも保存も呼ばずに、誤りの欄を示す', async () => {
    await renderLoaded(withReturns());
    changeField('日数', '0');

    fireEvent.click(saveReturnsButton());

    expect(screen.getByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(screen.getByLabelText('日数')).toBeInvalid();
    expect(mockedFetch).toHaveBeenCalledTimes(1); // 開く時の読み込みだけ
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('保存できた後に誤りを入れて「保存する」を押すと、前の保存の知らせを消し、誤りのまとめの文だけを出す', async () => {
    await renderLoaded(withReturns());
    serveSave(settings(), withReturns());
    fireEvent.click(saveReturnsButton());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    changeField('日数', '0');

    fireEvent.click(saveReturnsButton());

    expect(screen.getByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('保存に失敗した後に誤りを入れて「保存する」を押すと、窓口の失敗の文を消し、誤りのまとめの文だけを出す', async () => {
    await renderLoaded(withReturns());
    serveReread();
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    fireEvent.click(saveReturnsButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    changeField('日数', '0');

    fireEvent.click(saveReturnsButton());

    expect(screen.getByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(screen.queryByText(SAVE_FAILED)).not.toBeInTheDocument();
  });

  it.each<[string, () => Promise<Response>]>([
    ['500', () => Promise.resolve(json({ error: 'x', code: 'failed' }, 500))],
    ['403', () => Promise.resolve(json({ error: 'Forbidden' }, 403))],
    ['429', () => Promise.resolve(json({ error: 'Too many requests' }, 429))],
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('保存（PUT）できなかった時（%s）は、失敗の文を出し、入力は残す。保存の知らせは出さない', async (_label, answer) => {
    await renderLoaded(withReturns());
    serveReread();
    mockedFetch.mockImplementationOnce(answer);
    changeField('日数', '30');

    fireEvent.click(saveReturnsButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    expect(screen.getByLabelText('日数')).toHaveValue('30');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
    expect(saveReturnsButton()).toBeEnabled();
  });

  it('保存の直前の読み直しができなかった時は、保存の窓口を呼ばずに、失敗の文を出す', async () => {
    await renderLoaded(withReturns());
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    changeField('日数', '30');

    fireEvent.click(saveReturnsButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(putCalls()).toHaveLength(0);
    expect(screen.getByLabelText('日数')).toHaveValue('30');
  });

  it('保存の答えに返品の設定が無い時は、保存できたと確かめられないので、失敗の文を出して入力を残す', async () => {
    await renderLoaded(withReturns());
    serveSave(settings(), settings());
    changeField('日数', '30');

    fireEvent.click(saveReturnsButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByLabelText('日数')).toHaveValue('30');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('保存している間に「保存する」や自動の返金のトグルを押し直しても、読み直しも保存も二重に送らない', async () => {
    await renderLoaded(withReturns());
    serveReread();
    const { held, release } = hold();
    mockedFetch.mockImplementationOnce(() => held);

    fireEvent.click(saveReturnsButton());

    // 押した直後から保存が済むまで、画面は「保存中」（aria-busy）。ボタンは disabled にしない（キーボードのフォーカスを失わないため）
    expect(screen.getByRole('region', { name: 'ショップの設定' })).toHaveAttribute('aria-busy', 'true');
    expect(saveReturnsButton()).toBeEnabled();
    fireEvent.click(saveReturnsButton());
    fireEvent.click(autoRefundSwitch());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);

    release(json({ data: withReturns() }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    expect(screen.getByRole('region', { name: 'ショップの設定' })).toHaveAttribute('aria-busy', 'false');
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
  });

  it('自動の返金のトグルを保存している間に「保存する」を押すと、返品の欄は送らず、済んでから押し直すよう知らせる。保存が済むと知らせは消える', async () => {
    await renderLoaded(withReturns());
    serveReread();
    const { held, release } = hold();
    mockedFetch.mockImplementationOnce(() => held);

    fireEvent.click(autoRefundSwitch());
    fireEvent.click(saveReturnsButton());

    expect(screen.getByText(PRESSED_WHILE_SAVING)).toBeInTheDocument();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false });

    release(json({ data: settings({ autoRefund: { enabled: false } }) }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    expect(screen.queryByText(PRESSED_WHILE_SAVING)).not.toBeInTheDocument();
  });

  it('自動の返金のトグルを保存しても、返品の欄に入れかけの値は消えず、トグルの保存は返品の設定を送らない', async () => {
    await renderLoaded(withReturns());
    changeField('日数', '30');
    serveSave(settings(), withReturns(buildShopReturnSettings(), settings({ autoRefund: { enabled: false } })));

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(screen.getByLabelText('日数')).toHaveValue('30');
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false });
  });

  it('自動の返金のトグルの保存の答えに返品の設定が無くても、返品の欄は消えない', async () => {
    await renderLoaded(withReturns());
    serveSave(settings(), settings({ autoRefund: { enabled: false } }));

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(screen.getByRole('heading', { name: '返品', level: 3 })).toBeInTheDocument();
    expect(screen.getByLabelText('日数')).toBeInTheDocument();
  });
});

// 保存の結果の文（role="status"・role="alert"）は入れ物が1つずつのまま、CSS の order で見える位置を動かす（T12-13）。
// jsdom は配置を計算しないので、どの位置の印（order-*）が付くかを確かめる。画面の中に見えるかは Task 14 の E2E（FR-ADMIN-092）が確かめる
describe('ShopSettingsSection の保存の結果を見せる位置', () => {
  it('自動の返金の欄は order-1、返品の欄を包む入れ物は order-3。保存の知らせの入れ物は1つで、返品の欄の結果の位置（order-4）から始まる', async () => {
    await renderLoaded(withReturns());

    expect(screen.getByRole('region', { name: '自動の返金' })).toHaveClass('order-1');
    expect(regionOf('返品').parentElement).toHaveClass('order-3');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveClass('order-4', 'sr-only');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('保存の知らせは、トグルを保存した時は自動の返金の欄の直後（order-2）に、返品の欄を保存した時は返品の欄の直後（order-4）に見せる。入れ物は1つのまま', async () => {
    await renderLoaded(withReturns());
    serveSave(settings(), withReturns(buildShopReturnSettings(), settings({ autoRefund: { enabled: false } })));

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    expect(screen.getByRole('status')).toHaveClass('order-2');
    expect(screen.getByRole('status')).not.toHaveClass('order-4');

    serveSave(
      settings({ autoRefund: { enabled: false } }),
      withReturns(buildShopReturnSettings(), settings({ autoRefund: { enabled: false } })),
    );
    fireEvent.click(saveReturnsButton());

    await waitFor(() => expect(putCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    expect(screen.getByRole('status')).toHaveClass('order-4');
    expect(screen.getByRole('status')).not.toHaveClass('order-2');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('窓口の失敗の文も同じ。トグルの保存に失敗した時は自動の返金の欄の直後（order-2）に、返品の欄の保存に失敗した時は返品の欄の直後（order-4）に見せる。入れ物は1つのまま', async () => {
    await renderLoaded(withReturns());
    serveReread();
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));

    fireEvent.click(autoRefundSwitch());

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByRole('alert')).toHaveClass('order-2');

    serveReread();
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    fireEvent.click(saveReturnsButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(screen.getByRole('alert')).toHaveClass('order-4');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

// ここから下は、グループ E-3 段2（Task 13）で足した試験。窓口へ送る返品の設定が、申し込み・種類・注意書き・理由ごとの出す／ご希望／写真／案内の文を含む

describe('ShopSettingsSection の返品の欄の段2の欄', () => {
  /** PUT の returns に入る欄。段1の14と、段2の3（申し込みの受付・種類・注意書き） */
  const RETURNS_KEYS = [
    'returnAddress',
    'customerPaidMethod',
    'shopLabelFee',
    'noReturnNeededEnabled',
    'windowDays',
    'windowStart',
    'deliveryBufferDays',
    'reasons',
    'restockingFeeEnabled',
    'restockingFeePercent',
    'exchangeFeesEnabled',
    'exchangeFee',
    'exchangeShippingFee',
    'inspectionEnabled',
    'requestsEnabled',
    'requestTypes',
    'noticeText',
  ];

  it('「保存する」で、申し込みの受付・種類・注意書きと、理由ごとの出す・ご希望・写真・案内の文を、段1の欄と一緒に PUT の returns で送る。済むと窓口が返した値と最後に変えた人を出す', async () => {
    await renderLoaded(withReturns());
    const base = buildShopReturnSettings();
    const saved = buildShopReturnSettings({
      requestTypes: 'returns_and_cancellations',
      noticeText: '返品はお申し込みの後にご案内します。',
      updated: { ...base.updated, requests: { at: CHANGED_AT, byEmail: 'owner@example.com' } },
    });
    serveSave(settings(), withReturns(saved));
    fireEvent.change(screen.getByLabelText('申し込みの種類'), { target: { value: 'returns_and_cancellations' } });
    changeField('申し込みの画面の注意書き', '返品はお申し込みの後にご案内します。');

    fireEvent.click(saveReturnsButton());

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    const returns = putBody().returns as Record<string, unknown>;
    expect(Object.keys(returns).sort()).toEqual([...RETURNS_KEYS].sort());
    expect(returns).toMatchObject({
      requestsEnabled: true,
      requestTypes: 'returns_and_cancellations',
      noticeText: '返品はお申し込みの後にご案内します。',
    });
    const reasons = returns.reasons as Array<Record<string, unknown>>;
    expect(reasons).toHaveLength(10);
    expect(reasons[0]).toEqual({
      reason: 'defective',
      shown: true,
      resolutions: 'refund_and_exchange',
      photo: 'required',
      photoInstructions: '傷や不具合の場所がわかる写真をお送りください',
      shippingPayer: 'shop',
      outOfStockExchange: 'make',
    });
    // 窓口が返した値で画面を置き換え、申し込みのまとまりに最後に変えた人を出す
    expect(screen.getByLabelText('申し込みの種類')).toHaveValue('returns_and_cancellations');
    expect(
      within(regionOf('申し込み')).getByText(`最後に変えた人: owner@example.com（${screenTime(CHANGED_AT)}）`),
    ).toBeInTheDocument();
  });

  it('理由ごとの「出す」「写真」を変えて保存すると、変えた行だけが変わった値で PUT の returns.reasons に入る', async () => {
    await renderLoaded(withReturns());
    serveSave(settings(), withReturns());
    const row = within(screen.getByRole('group', { name: 'その他' }));
    fireEvent.click(row.getByRole('checkbox', { name: '出す' }));
    fireEvent.change(row.getByLabelText('写真'), { target: { value: 'required' } });

    fireEvent.click(saveReturnsButton());

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(SAVED));
    const reasons = (putBody().returns as { reasons: Array<Record<string, unknown>> }).reasons;
    expect(reasons.find((item) => item.reason === 'other')).toMatchObject({ shown: false, photo: 'required' });
    expect(reasons.find((item) => item.reason === 'size_too_small')).toMatchObject({ shown: true, photo: 'optional' });
    expect(reasons.find((item) => item.reason === 'unknown')).toMatchObject({ shown: false, photo: 'none' });
  });

  it('注意書きが長すぎる時は、読み直しも保存も呼ばずに、誤りの欄を示す', async () => {
    await renderLoaded(withReturns());
    changeField('申し込みの画面の注意書き', 'あ'.repeat(2001));

    fireEvent.click(saveReturnsButton());

    expect(screen.getByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(screen.getByLabelText('申し込みの画面の注意書き')).toBeInvalid();
    expect(mockedFetch).toHaveBeenCalledTimes(1); // 開く時の読み込みだけ
  });
});

// ここから下は、グループ E-4 の Task 11（ショップの設定の「配送の追跡」の欄）で足した試験。窓口の答えに deliveryTracking が付く

const DELIVERY_SWITCH_NAME = '配送の追跡（17TRACK）を使う';
const DELIVERY_EXPLANATIONS = [
  'オンにすると、発送した荷物の配送状況（配達中・配達済みなど）を 17TRACK から受け取り、お客様の注文の画面に出し、配達中・配達済みのメールを送ります。17TRACK には配送業者と伝票番号だけを渡します',
  '17TRACK の利用料がかかります（最初の200件は無料。その後は年払い）。佐川急便の荷物は、佐川急便の追跡が止まっている間は追えません',
  'オフの間も、伝票番号の直しと、手で配達済みにすることはできます',
];
const DELIVERY_ON_CONFIRM_TITLE = '配送の追跡を使う';
const DELIVERY_OFF_CONFIRM_TITLE = '配送の追跡を止める';
const DELIVERY_OFF_CONFIRM = '追跡を止め、配送の要対応を閉じます。記録した配送状況は残ります';
const DELIVERY_REREAD_FAILED = '設定を保存できませんでした。現在の設定を読み直しました。';
const KEY_MISSING_HINT = '17TRACK の鍵を設定してください';
const CHECKING_COUNT = '件数を確かめています…';

const deliveryOnConfirm = (count: number) =>
  `30日以内に発送した配達済みでない発送（${count}件）も 17TRACK に登録します。1件ごとに 17TRACK の件数を使います`;

/** 窓口の答えの deliveryTracking。既定はオフ・鍵あり・件数0・まだ誰も変えていない */
function delivery(overrides: Partial<DeliveryTrackingSettings> = {}): DeliveryTrackingSettings {
  return { enabled: false, updatedAt: null, updatedByEmail: null, keyConfigured: true, backfillCount: 0, ...overrides };
}

/** 配送の設定（と任意の返品の設定）が付いた窓口の答え。形の違う値も渡せるよう unknown にする */
type AnswerWithDelivery = ShopSettings & { returns?: unknown; deliveryTracking?: unknown; backfilledCount?: number };

function withDelivery(
  deliveryTracking: unknown = delivery(),
  toggles: ShopSettings = settings(),
  returns?: unknown,
): AnswerWithDelivery {
  return { ...toggles, deliveryTracking, ...(returns === undefined ? {} : { returns }) };
}

const deliveryRegion = () => screen.getByRole('region', { name: '配送の追跡' });
const deliverySwitch = () => screen.getByRole('switch', { name: DELIVERY_SWITCH_NAME });

/** 配送の欄が出す保存の知らせ・失敗の文（欄の中。自動の返金と返品の結果の文は別の入れ物） */
const deliveryStatus = () => within(deliveryRegion()).getByRole('status');

/** ON の確かめを開く: 押す → 直前の読み直し（GET）の答え → 確かめの画面 */
async function openDeliveryOnConfirm(latest: AnswerWithDelivery) {
  serveReread(latest);
  fireEvent.click(deliverySwitch());
  return screen.findByRole('dialog', { name: DELIVERY_ON_CONFIRM_TITLE });
}

describe('ShopSettingsSection の「配送の追跡」の欄の表示', () => {
  it('自動の返金、配送の追跡、返品の順に出す', async () => {
    await renderLoaded(withDelivery(delivery(), settings(), buildShopReturnSettings()));

    const sectionNames = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(sectionNames).toEqual(['自動の返金', '配送の追跡', '返品']);
    // 見た目の並びは CSS の order。配送の欄は返品の欄を包む入れ物（order-3）と同じ番号で、DOM では返品の前に置く
    expect(deliveryRegion()).toHaveClass('order-3');
    expect(deliverySwitch()).not.toBeChecked();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('答えに deliveryTracking が無い（古い窓口の形の）時は、配送の欄を出さず、ほかの欄はそのまま出す', async () => {
    await renderLoaded(withReturns());

    expect(screen.queryByRole('region', { name: '配送の追跡' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: DELIVERY_SWITCH_NAME })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '返品', level: 3 })).toBeInTheDocument();
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['オンかどうかが真偽でない', delivery({ enabled: 'yes' as unknown as boolean })],
    ['鍵の有無が無い', { ...delivery(), keyConfigured: undefined }],
    ['件数が文字', delivery({ backfillCount: '3' as unknown as number })],
    ['件数が負', delivery({ backfillCount: -1 })],
    ['件数が小数', delivery({ backfillCount: 1.5 })],
    ['最後に変えた時刻が数', delivery({ updatedAt: 5 as unknown as string })],
    ['最後に変えた人が数', delivery({ updatedByEmail: 5 as unknown as string })],
  ])('deliveryTracking の形が違う時（%s）は、読み込めなかった旨を出し、トグルは出さない', async (_label, deliveryTracking) => {
    mockedFetch.mockResolvedValueOnce(json({ data: withDelivery(deliveryTracking) }));

    render(<ShopSettingsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it.each<[string, boolean]>([
    ['鍵が設定済み', true],
    ['鍵が未設定', false],
  ])('説明の3文は全文を、%sでも出す', async (_label, keyConfigured) => {
    await renderLoaded(withDelivery(delivery({ keyConfigured })));

    for (const sentence of DELIVERY_EXPLANATIONS) {
      expect(within(deliveryRegion()).getByText(sentence)).toBeVisible();
    }
  });

  it('鍵が設定済みなら「鍵：設定済み」を出し、トグルは押せる。「鍵を設定してください」は出さない', async () => {
    await renderLoaded(withDelivery(delivery({ keyConfigured: true })));

    expect(screen.getByText('鍵：設定済み')).toBeVisible();
    expect(screen.queryByText('鍵：未設定')).not.toBeInTheDocument();
    expect(screen.queryByText(KEY_MISSING_HINT)).not.toBeInTheDocument();
    expect(deliverySwitch()).toBeEnabled();
  });

  it('鍵の値は出さず未設定ならトグルを押せない。「鍵：未設定」と「17TRACK の鍵を設定してください」を出し、押しても何も呼ばない', async () => {
    // 窓口が鍵の値を余計に返しても、画面には出さない（読むのは5つの項目だけ）
    await renderLoaded(withDelivery({ ...delivery({ keyConfigured: false }), apiKey: 'sk-live-secret-value' }));

    expect(deliverySwitch()).toBeDisabled();
    expect(screen.getByText('鍵：未設定')).toBeVisible();
    expect(screen.getByText(KEY_MISSING_HINT)).toBeVisible();
    expect(document.body).not.toHaveTextContent('sk-live-secret-value');
    fireEvent.click(deliverySwitch());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(1); // 開く時の読み込みだけ
    // 鍵を入れる欄は作らない
    expect(within(deliveryRegion()).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('すでにオンで鍵が無くなった時は、オフへ戻す操作を許す（トグルは押せる）。「鍵：未設定」と案内は出す', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true, keyConfigured: false })));

    expect(deliverySwitch()).toBeChecked();
    expect(deliverySwitch()).toBeEnabled();
    expect(screen.getByText('鍵：未設定')).toBeVisible();
    expect(screen.getByText(KEY_MISSING_HINT)).toBeVisible();
  });

  it('最後に変えた人と時刻を「最後の変更：{日時}・{人}」で、配送の欄の中だけに出す', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' })));

    const line = screen.getByTestId('shop-setting-delivery-tracking-updated');
    expect(line).toHaveTextContent(`最後の変更：${screenTime(CHANGED_AT)}・owner@example.com`);
    expect(line).toHaveTextContent('10:30'); // 日本時間
    expect(deliveryRegion()).toContainElement(line);
  });

  it('時刻があって人が空の時は「不明」と出す', async () => {
    await renderLoaded(withDelivery(delivery({ updatedAt: CHANGED_AT, updatedByEmail: null })));

    expect(screen.getByTestId('shop-setting-delivery-tracking-updated')).toHaveTextContent(
      `最後の変更：${screenTime(CHANGED_AT)}・不明`,
    );
  });

  it('時刻が空（まだ誰も変えていない）の時は、行を出さない', async () => {
    await renderLoaded(withDelivery(delivery({ updatedAt: null, updatedByEmail: 'owner@example.com' })));

    expect(screen.queryByTestId('shop-setting-delivery-tracking-updated')).not.toBeInTheDocument();
    expect(screen.queryByText(/最後の変更/)).not.toBeInTheDocument();
  });
});

describe('ShopSettingsSection の配送の追跡をオンにする時の確かめ', () => {
  it('ON前にGETで件数を読み直しN件を確認する。確かめの間は保存せず、トグルはオフのまま', async () => {
    await renderLoaded(withDelivery(delivery({ backfillCount: 3 })));

    const dialog = await openDeliveryOnConfirm(withDelivery(delivery({ backfillCount: 12 })));

    expect(within(dialog).getByText(deliveryOnConfirm(12))).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'オンにする' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();
    expect(screen.queryByText(deliveryOnConfirm(3))).not.toBeInTheDocument();
    expect(callOrder()).toEqual(['GET', 'GET']);
    expect(mockedFetch).toHaveBeenNthCalledWith(2, SETTINGS_URL, { cache: 'no-store' });
    expect(putCalls()).toHaveLength(0);
    expect(deliverySwitch()).not.toBeChecked();
    expect(screen.queryByText(CHECKING_COUNT)).not.toBeInTheDocument();
  });

  it('読み直している間は「件数を確かめています…」を出し、確かめの画面はまだ出さない。押し直しても読み直しは増えない', async () => {
    await renderLoaded(withDelivery(delivery({ backfillCount: 3 })));
    const { held, release } = hold();
    mockedFetch.mockImplementationOnce(() => held);

    fireEvent.click(deliverySwitch());

    expect(screen.getByText(CHECKING_COUNT)).toBeVisible();
    expect(screen.getByRole('region', { name: 'ショップの設定' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(deliverySwitch());
    fireEvent.click(autoRefundSwitch());
    fireEvent.click(autoCancelSwitch());
    expect(callOrder()).toEqual(['GET', 'GET']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    release(json({ data: withDelivery(delivery({ backfillCount: 12 })) }));

    expect(await screen.findByRole('dialog', { name: DELIVERY_ON_CONFIRM_TITLE })).toBeInTheDocument();
    expect(screen.queryByText(CHECKING_COUNT)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'ショップの設定' })).toHaveAttribute('aria-busy', 'false');
    expect(callOrder()).toEqual(['GET', 'GET']);
  });

  it('0件でも確かめを出す（0件と書いて、オンにできる）', async () => {
    await renderLoaded(withDelivery(delivery({ backfillCount: 5 })));

    const dialog = await openDeliveryOnConfirm(withDelivery(delivery({ backfillCount: 0 })));

    expect(within(dialog).getByText(deliveryOnConfirm(0))).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'オンにする' })).toBeEnabled();
  });

  it('読み直した鍵・自動の返金の2つの値で画面を取り直す（別のタブで②がオンになっていたら、確かめの時点で②もオンに見せる）', async () => {
    await renderLoaded(withDelivery(delivery(), settings()));
    expect(autoCancelSwitch()).not.toBeChecked();

    await openDeliveryOnConfirm(
      withDelivery(delivery(), settings({ autoCancel: { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' } })),
    );

    expect(autoCancelSwitch()).toBeChecked();
    expect(screen.getByTestId('shop-setting-auto-cancel-updated')).toHaveTextContent('最後に変えた人: staff@example.com');
  });

  it('確認を戻るとPUTしない。トグルはオフのまま、フォーカスはトグルへ戻る', async () => {
    await renderLoaded(withDelivery(delivery({ backfillCount: 2 })));
    const toggle = deliverySwitch();
    toggle.focus();
    const dialog = await openDeliveryOnConfirm(withDelivery(delivery({ backfillCount: 2 })));

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(deliverySwitch()).not.toBeChecked();
    expect(deliveryStatus()).toBeEmptyDOMElement();
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('Escape でも「戻る」と同じに、保存せずに閉じる', async () => {
    await renderLoaded(withDelivery());
    await openDeliveryOnConfirm(withDelivery());

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(deliverySwitch()).not.toBeChecked();
  });

  it('「オンにする」で、保存の直前に読み直した2つのトグルと配送だけをPUTし、返品の設定は送らない。保存の答えで画面を置き換え、確認中に件数が増えても失敗にしない', async () => {
    const earlier = withDelivery(delivery({ backfillCount: 3 }), settings(), buildShopReturnSettings());
    await renderLoaded(earlier);
    // 確かめを開く前に読み直した値: 件数は12。②はオフのまま
    const dialog = await openDeliveryOnConfirm(withDelivery(delivery({ backfillCount: 12 }), settings(), buildShopReturnSettings()));
    // 確かめている間に別のタブで②がオンになり、新しい発送も増えた。保存の直前の読み直しは②オン。保存で取り込んだ実数は14件だった
    const staffToggle = { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    const saved: AnswerWithDelivery = {
      ...withDelivery(
        delivery({ enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com', backfillCount: 0 }),
        settings({ autoCancel: staffToggle }),
        buildShopReturnSettings(),
      ),
      backfilledCount: 14,
    };
    serveSave(withDelivery(delivery({ backfillCount: 14 }), settings({ autoCancel: staffToggle }), buildShopReturnSettings()), saved);

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    await waitFor(() => expect(deliverySwitch()).toBeChecked());
    // 開く時の読み込み・確かめの前の読み直し・保存の直前の読み直し・保存
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'PUT']);
    expect(mockedFetch).toHaveBeenNthCalledWith(3, SETTINGS_URL, { cache: 'no-store' });
    expect(putCalls()[0][0]).toBe(SETTINGS_URL);
    expect(putCalls()[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    const body = putBody();
    expect(body).toEqual({
      autoRefundCancelledOrderPayment: true,
      autoCancelAmountMismatch: true,
      deliveryTracking: { enabled: true },
    });
    expect(body).not.toHaveProperty('returns');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deliveryStatus()).toHaveTextContent(SAVED);
    expect(within(deliveryRegion()).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('shop-setting-delivery-tracking-updated')).toHaveTextContent(
      `最後の変更：${screenTime(CHANGED_AT)}・owner@example.com`,
    );
    expect(autoCancelSwitch()).toBeChecked();
  });

  it('確かめの画面から保存している間は、2つのボタンを押せず、Escape でも閉じず、二重に送らない。済むと閉じる', async () => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery());
    serveReread(withDelivery()); // 保存の直前の読み直し
    const { held, release } = hold();
    mockedFetch.mockImplementationOnce(() => held);

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(within(dialog).getByRole('button', { name: 'オンにする' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeDisabled();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(autoRefundSwitch());
    expect(screen.getByRole('dialog', { name: DELIVERY_ON_CONFIRM_TITLE })).toBeInTheDocument();
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'PUT']);

    release(json({ data: withDelivery(delivery({ enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' })) }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deliverySwitch()).toBeChecked();
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'PUT']);
  });

  it('確かめを開いている間に別のタブで変わった自動の返金の値は、「オンにする」の保存で戻さない（保存の直前に読み直した値を送る）', async () => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery()); // 開いた時は ①オン・②オフ
    // 確かめを開いている間に、別のタブで①がオフ・②がオンになった
    const offElsewhere = { enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    const onElsewhere = { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    const changed = settings({ autoRefund: offElsewhere, autoCancel: onElsewhere });
    serveSave(withDelivery(delivery(), changed), withDelivery(delivery({ enabled: true }), changed));

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    await waitFor(() => expect(deliverySwitch()).toBeChecked());
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'PUT']);
    expect(putBody()).toEqual({
      autoRefundCancelledOrderPayment: false,
      autoCancelAmountMismatch: true,
      deliveryTracking: { enabled: true },
    });
    expect(autoRefundSwitch()).not.toBeChecked();
    expect(autoCancelSwitch()).toBeChecked();
  });

  it('保存の直前の読み直しで鍵が消えていたら、保存せずに確かめを閉じ、「鍵：未設定」へ替えてトグルを押せなくする', async () => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery());
    serveReread(withDelivery(delivery({ keyConfigured: false })));

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(putCalls()).toHaveLength(0);
    expect(callOrder()).toEqual(['GET', 'GET', 'GET']);
    expect(deliverySwitch()).toBeDisabled();
    expect(deliverySwitch()).not.toBeChecked();
    expect(screen.getByText('鍵：未設定')).toBeVisible();
    expect(screen.getByText(KEY_MISSING_HINT)).toBeVisible();
    expect(within(deliveryRegion()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each<[string, () => Promise<Response>]>([
    ['窓口が断った', () => Promise.resolve(json({ error: 'x', code: 'failed' }, 500))],
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['答えに deliveryTracking が無い', () => Promise.resolve(json({ data: settings() }))],
  ])('保存の直前の読み直しができなかった時（%s）は、保存せず、もう一度読み直して、読み直した旨を出す', async (_label, answer) => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery());
    const staffToggle = { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    mockedFetch.mockImplementationOnce(answer);
    serveReread(withDelivery(delivery(), settings({ autoCancel: staffToggle })));

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(DELIVERY_REREAD_FAILED);
    expect(putCalls()).toHaveLength(0);
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deliverySwitch()).not.toBeChecked();
    expect(autoCancelSwitch()).toBeChecked(); // もう一度読み直した値で合わせる
  });

  it('保存の直前の読み直しも、そのもう一度の読み直しもできなかった時は、読み直したとは言わず、保存できなかった旨だけを出す', async () => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery());
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    mockedFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(screen.queryByText(DELIVERY_REREAD_FAILED)).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deliverySwitch()).not.toBeChecked();
    expect(deliverySwitch()).toBeEnabled();
  });

  it('確かめの前の読み直しで鍵が消えていたら、確かめを出さずに「鍵：未設定」へ替え、トグルを押せなくする', async () => {
    await renderLoaded(withDelivery(delivery({ keyConfigured: true })));

    serveReread(withDelivery(delivery({ keyConfigured: false })));
    fireEvent.click(deliverySwitch());

    await waitFor(() => expect(deliverySwitch()).toBeDisabled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('鍵：未設定')).toBeVisible();
    expect(screen.getByText(KEY_MISSING_HINT)).toBeVisible();
    expect(putCalls()).toHaveLength(0);
    expect(deliverySwitch()).not.toBeChecked();
  });

  it.each<[string, () => Promise<Response>]>([
    ['窓口が断った', () => Promise.resolve(json({ error: 'x', code: 'failed' }, 500))],
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['答えに deliveryTracking が無い', () => Promise.resolve(json({ data: settings() }))],
  ])('確かめの前の読み直しができなかった時（%s）は、確かめを出さず、読み込めなかった旨を欄に出す。保存はしない', async (_label, answer) => {
    await renderLoaded(withDelivery());
    mockedFetch.mockImplementationOnce(answer);

    fireEvent.click(deliverySwitch());

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    expect(deliverySwitch()).not.toBeChecked();
    expect(screen.queryByText(CHECKING_COUNT)).not.toBeInTheDocument();
  });
});

describe('ShopSettingsSection の配送の追跡をオフにする時の確かめ', () => {
  it('オンのトグルを押すと、読み直さずに確かめを出す（題と全文とボタン）。まだ保存しない', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true })));

    fireEvent.click(deliverySwitch());

    const dialog = await screen.findByRole('dialog', { name: DELIVERY_OFF_CONFIRM_TITLE });
    expect(within(dialog).getByText(DELIVERY_OFF_CONFIRM)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'オフにする' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();
    expect(deliverySwitch()).toBeChecked();
    expect(callOrder()).toEqual(['GET']);
  });

  it('「戻る」では保存せずに閉じ、トグルはオンのまま', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true })));
    fireEvent.click(deliverySwitch());
    const dialog = await screen.findByRole('dialog', { name: DELIVERY_OFF_CONFIRM_TITLE });

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(deliverySwitch()).toBeChecked();
  });

  it('OFF確認と保存は配送だけを変える。保存の直前に読み直した2つのトグルと配送のオフだけを送り、返品の設定は送らない', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true }), settings(), buildShopReturnSettings()));
    fireEvent.click(deliverySwitch());
    const dialog = await screen.findByRole('dialog', { name: DELIVERY_OFF_CONFIRM_TITLE });
    // 保存の直前の読み直しでは、別のタブで②がオンになっていた
    const staffToggle = { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    serveSave(
      withDelivery(delivery({ enabled: true }), settings({ autoCancel: staffToggle })),
      withDelivery(
        delivery({ enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' }),
        settings({ autoCancel: staffToggle }),
        buildShopReturnSettings(),
      ),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'オフにする' }));

    await waitFor(() => expect(deliverySwitch()).not.toBeChecked());
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);
    const body = putBody();
    expect(body.deliveryTracking).toEqual({ enabled: false });
    expect(body).not.toHaveProperty('returns');
    expect(body).toEqual({
      autoRefundCancelledOrderPayment: true,
      autoCancelAmountMismatch: true,
      deliveryTracking: { enabled: false },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deliveryStatus()).toHaveTextContent(SAVED);
    expect(screen.getByTestId('shop-setting-delivery-tracking-updated')).toHaveTextContent(
      `最後の変更：${screenTime(CHANGED_AT)}・owner@example.com`,
    );
    expect(autoCancelSwitch()).toBeChecked();
  });

  it('オンのまま鍵が無くなった店でも、オフへ戻せる（確かめも保存も通る）', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true, keyConfigured: false })));
    fireEvent.click(deliverySwitch());
    const dialog = await screen.findByRole('dialog', { name: DELIVERY_OFF_CONFIRM_TITLE });
    serveSave(
      withDelivery(delivery({ enabled: true, keyConfigured: false })),
      withDelivery(delivery({ enabled: false, keyConfigured: false, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' })),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'オフにする' }));

    await waitFor(() => expect(deliverySwitch()).not.toBeChecked());
    expect(putBody().deliveryTracking).toEqual({ enabled: false });
    // オフになった後は、鍵が無いのでオンへは押せない
    expect(deliverySwitch()).toBeDisabled();
  });

  it('保存の直前の読み直しも、そのもう一度の読み直しもできなかった時は、保存の窓口を呼ばずに、保存できなかった旨を欄に出す。確かめは閉じる', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true })));
    fireEvent.click(deliverySwitch());
    const dialog = await screen.findByRole('dialog', { name: DELIVERY_OFF_CONFIRM_TITLE });
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));

    fireEvent.click(within(dialog).getByRole('button', { name: 'オフにする' }));

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(putCalls()).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deliverySwitch()).toBeChecked();
    expect(callOrder()).toEqual(['GET', 'GET', 'GET']);
  });

  it('保存の直前の読み直しができなくても、もう一度の読み直しができれば、保存せずに読み直した旨を出して、その値で合わせる', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true })));
    fireEvent.click(deliverySwitch());
    const dialog = await screen.findByRole('dialog', { name: DELIVERY_OFF_CONFIRM_TITLE });
    mockedFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    serveReread(withDelivery(delivery({ enabled: false, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' })));

    fireEvent.click(within(dialog).getByRole('button', { name: 'オフにする' }));

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(DELIVERY_REREAD_FAILED);
    expect(putCalls()).toHaveLength(0);
    expect(deliverySwitch()).not.toBeChecked();
    expect(callOrder()).toEqual(['GET', 'GET', 'GET']);
  });
});

describe('ShopSettingsSection の配送の追跡の保存の失敗', () => {
  it.each<[string, () => Promise<Response>]>([
    ['500', () => Promise.resolve(json({ error: 'x', code: 'failed' }, 500))],
    ['鍵が無い（409）', () => Promise.resolve(json({ error: '17TRACK の鍵を設定してください。', code: 'DELIVERY_TRACKING_KEY_MISSING' }, 409))],
    ['403', () => Promise.resolve(json({ error: 'Forbidden' }, 403))],
    ['429', () => Promise.resolve(json({ error: 'Too many requests' }, 429))],
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['答えに deliveryTracking が無い', () => Promise.resolve(json({ data: settings() }))],
  ])('途中の失敗（PUT が%s）はGETし直し、部分保存した値を反映して、読み直した旨を出す', async (_label, answer) => {
    await renderLoaded(withDelivery(delivery({ backfillCount: 3 })));
    const dialog = await openDeliveryOnConfirm(withDelivery(delivery({ backfillCount: 12 })));
    // PUT は失敗したが、先に保存した②のオンは残り、鍵はその間に消えた。読み直した値が画面の正
    const staffToggle = { enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' };
    serveReread(withDelivery(delivery({ backfillCount: 12 }))); // 保存の直前の読み直し（この時点では鍵あり）
    mockedFetch.mockImplementationOnce(answer);
    mockedFetch.mockResolvedValueOnce(
      json({ data: withDelivery(delivery({ keyConfigured: false, backfillCount: 0 }), settings({ autoCancel: staffToggle })) }),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(DELIVERY_REREAD_FAILED);
    expect(screen.getByText(DELIVERY_REREAD_FAILED)).toBeVisible();
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'PUT', 'GET']);
    expect(mockedFetch).toHaveBeenNthCalledWith(5, SETTINGS_URL, { cache: 'no-store' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deliverySwitch()).not.toBeChecked();
    expect(deliverySwitch()).toBeDisabled();
    expect(screen.getByText('鍵：未設定')).toBeVisible();
    expect(autoCancelSwitch()).toBeChecked();
    expect(deliveryStatus()).toBeEmptyDOMElement();
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('失敗の後の読み直しでオンになっていたら、オンで出す（保存が実は届いていた場合）', async () => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery());
    serveReread(withDelivery()); // 保存の直前の読み直し
    mockedFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mockedFetch.mockResolvedValueOnce(
      json({ data: withDelivery(delivery({ enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' })) }),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(DELIVERY_REREAD_FAILED);
    expect(deliverySwitch()).toBeChecked();
    expect(screen.getByTestId('shop-setting-delivery-tracking-updated')).toHaveTextContent('owner@example.com');
  });

  it('失敗の後の読み直しもできなかった時は、読み直したとは言わず、保存できなかった旨だけを出す。画面の値は変えない', async () => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery());
    serveReread(withDelivery()); // 保存の直前の読み直し
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    mockedFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(SAVE_FAILED);
    expect(screen.queryByText(DELIVERY_REREAD_FAILED)).not.toBeInTheDocument();
    expect(callOrder()).toEqual(['GET', 'GET', 'GET', 'PUT', 'GET']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deliverySwitch()).not.toBeChecked();
    expect(deliverySwitch()).toBeEnabled();
  });

  it('失敗の後にもう一度保存できると、失敗の文は消えて、欄に保存の知らせが出る', async () => {
    await renderLoaded(withDelivery());
    let dialog = await openDeliveryOnConfirm(withDelivery());
    serveReread(withDelivery()); // 保存の直前の読み直し
    mockedFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    serveReread(withDelivery());
    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));
    expect(await within(deliveryRegion()).findByRole('alert')).toHaveTextContent(DELIVERY_REREAD_FAILED);

    dialog = await openDeliveryOnConfirm(withDelivery());
    serveSave(withDelivery(), withDelivery(delivery({ enabled: true })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));

    await waitFor(() => expect(deliveryStatus()).toHaveTextContent(SAVED));
    expect(within(deliveryRegion()).queryByRole('alert')).not.toBeInTheDocument();
    expect(deliverySwitch()).toBeChecked();
    expect(putCalls()).toHaveLength(2);
  });
});

describe('ShopSettingsSection の配送の追跡と、ほかの欄の保存の分担', () => {
  it('返品の保存は配送の入力を送らない（自動の返金の2つと returns だけ）。配送の欄はそのまま残る', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'owner@example.com' }), settings(), buildShopReturnSettings()));
    // 返品の保存の答えに deliveryTracking が無くても、配送の欄は消さない
    serveSave(withDelivery(delivery({ enabled: true }), settings()), withReturns(buildShopReturnSettings(), settings()));

    fireEvent.click(saveReturnsButton());

    expect(await screen.findByText(SAVED)).toBeInTheDocument();
    expect(putCalls()).toHaveLength(1);
    const body = putBody();
    expect(Object.keys(body).sort()).toEqual(['autoCancelAmountMismatch', 'autoRefundCancelledOrderPayment', 'returns']);
    expect(body).not.toHaveProperty('deliveryTracking');
    expect(screen.getByTestId('shop-setting-delivery-tracking-updated')).toHaveTextContent('owner@example.com');
    expect(deliverySwitch()).toBeChecked();
  });

  it('自動の返金のトグルの保存は配送の入力を送らず、答えの deliveryTracking で配送の欄を置き換える', async () => {
    await renderLoaded(withDelivery(delivery({ enabled: false })));
    serveSave(
      withDelivery(delivery({ enabled: false })),
      withDelivery(delivery({ enabled: true, updatedAt: CHANGED_AT, updatedByEmail: 'staff@example.com' }), settings({ autoRefund: { enabled: false } })),
    );

    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(putBody()).toEqual({ autoRefundCancelledOrderPayment: false, autoCancelAmountMismatch: false });
    expect(deliverySwitch()).toBeChecked();
    expect(screen.getByTestId('shop-setting-delivery-tracking-updated')).toHaveTextContent('staff@example.com');
  });

  it('配送の保存の知らせが出ている時に自動の返金を保存すると、配送の欄の知らせは消える（古い知らせを残さない）', async () => {
    await renderLoaded(withDelivery());
    const dialog = await openDeliveryOnConfirm(withDelivery());
    serveSave(withDelivery(), withDelivery(delivery({ enabled: true })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'オンにする' }));
    await waitFor(() => expect(deliveryStatus()).toHaveTextContent(SAVED));

    serveSave(withDelivery(delivery({ enabled: true })), withDelivery(delivery({ enabled: true }), settings({ autoRefund: { enabled: false } })));
    fireEvent.click(autoRefundSwitch());

    await waitFor(() => expect(autoRefundSwitch()).not.toBeChecked());
    expect(deliveryStatus()).toBeEmptyDOMElement();
  });
});
