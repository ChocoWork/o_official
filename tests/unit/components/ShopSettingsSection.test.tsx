import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ShopSettingsSection from '@/components/ShopSettingsSection';
import { clientFetch } from '@/lib/client-fetch';
import type { ShopSettingToggle, ShopSettings } from '@/lib/orders/refund/refund-types';

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
  it('保存している間は2つのトグルを押せず、読み直しも保存も二重に送らない。済むと押せる', async () => {
    await renderLoaded();
    serveReread();
    const { held, release } = hold();
    mockedFetch.mockImplementationOnce(() => held);

    fireEvent.click(autoRefundSwitch());

    // 押した直後（読み直しの答えを待つ間）から、2つのトグルは押せない
    expect(autoRefundSwitch()).toBeDisabled();
    expect(autoCancelSwitch()).toBeDisabled();
    fireEvent.click(autoRefundSwitch());
    fireEvent.click(autoCancelSwitch());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 読み直しの後に保存が出る（答えは止めてある）。押し直しても、読み直しも保存も増えない
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(callOrder()).toEqual(['GET', 'GET', 'PUT']);

    release(json({ data: settings({ autoRefund: { enabled: false } }) }));

    await waitFor(() => expect(autoRefundSwitch()).toBeEnabled());
    expect(autoCancelSwitch()).toBeEnabled();
    expect(autoRefundSwitch()).not.toBeChecked();
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
