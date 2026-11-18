/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-084 管理画面「ユーザー」の店員の操作（招待・やり直し・お客さんに戻す・招待の取り消し・店員にする）
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserSection from '@/components/UserSection';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
import { clientFetch } from '@/lib/client-fetch';

const mockFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const ADMIN_ME = '11111111-1111-4111-8111-111111111111';
const ADMIN_2 = '22222222-2222-4222-8222-222222222222';
const SUPPORTER = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const INVITED = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, unknown>;
const row = (id: string, email: string, roleValue: string, extra: Row = {}): Row => ({
  id, name: `名前 ${email.split('@')[0]}`, email, role: roleValue, roleValue, lastLogin: '-', status: 'アクティブ', ...extra,
});

let users: Row[];
let respond: (url: string, init?: RequestInit) => { status: number; body?: unknown } | null;

function calls(method: string) {
  return mockFetch.mock.calls.filter(([, init]) => init?.method === method);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  users = [
    row(ADMIN_ME, 'me@example.com', 'admin', { approvedPasskeys: 2 }),
    row(ADMIN_2, 'admin2@example.com', 'admin', { approvedPasskeys: 2 }),
    row(SUPPORTER, 'support@example.com', 'supporter', { approvedPasskeys: 1 }),
    row(CUSTOMER, 'customer@example.com', 'user', { approvedPasskeys: 0, invitePending: false }),
    row(INVITED, 'invited@example.com', 'user', { approvedPasskeys: 0, invitePending: true }),
  ];
  respond = () => null;
  mockFetch.mockImplementation(async (url, init) => {
    const custom = respond(String(url), init);
    if (custom) return { ok: custom.status < 400, status: custom.status, json: async () => custom.body ?? {} } as Response;
    if (String(url) === '/api/auth/me') {
      return { ok: true, status: 200, json: async () => ({ authenticated: true, user: { id: ADMIN_ME } }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ data: users }) } as Response;
  });
});

afterEach(() => jest.restoreAllMocks());

async function rowOf(email: string) {
  const cell = await screen.findByText(email);
  return cell.closest('tr') as HTMLElement;
}

describe('DD-AUTH-084 店員の行の操作', () => {
  it('DD-AUTH-084 店員の行に認めた鍵の本数と、やり直し・お客さんに戻すが出る', async () => {
    render(<UserSection />);
    const support = await rowOf('support@example.com');
    expect(within(support).getByText('認めた鍵 1本')).toBeInTheDocument();
    expect(within(support).getByRole('button', { name: 'パスキーを全部消してやり直す' })).toBeEnabled();
    expect(within(support).getByRole('button', { name: 'お客さんに戻す' })).toBeEnabled();
  });

  it('DD-AUTH-084 自分の行は押せず、理由を文で出す', async () => {
    render(<UserSection />);
    const me = await rowOf('me@example.com');
    await waitFor(() => expect(within(me).getByRole('button', { name: 'お客さんに戻す' })).toBeDisabled());
    expect(within(me).getByRole('button', { name: 'パスキーを全部消してやり直す' })).toBeDisabled();
    expect(within(me).getByText('自分自身は変更できません。')).toBeInTheDocument();
  });

  it('DD-AUTH-084 最後の店長の行は押せない', async () => {
    users = [row(ADMIN_2, 'admin2@example.com', 'admin', { approvedPasskeys: 2 }), row(SUPPORTER, 'support@example.com', 'supporter')];
    render(<UserSection />);
    const last = await rowOf('admin2@example.com');
    expect(within(last).getByRole('button', { name: 'お客さんに戻す' })).toBeDisabled();
    expect(within(last).getByText('店長を1人以上残してください。')).toBeInTheDocument();
  });

  it('DD-AUTH-084 お客さんに戻すは確認の後に demote を呼び、一覧を読み直す', async () => {
    const user = userEvent.setup();
    render(<UserSection />);
    const support = await rowOf('support@example.com');
    await user.click(within(support).getByRole('button', { name: 'お客さんに戻す' }));
    const dialog = await screen.findByRole('dialog', { name: 'お客さんに戻す' });
    expect(calls('POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'お客さんに戻す' }));
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
    expect(calls('POST')[0][0]).toBe(`/api/admin/staff/${SUPPORTER}/demote`);
    expect(await screen.findByText('support@example.com をお客さんに戻しました。')).toBeInTheDocument();
  });
});

describe('DD-AUTH-084 店員の行の役割の選択', () => {
  it('DD-AUTH-084 店員の行の選択欄に User は無く、確認なしで降格する道が無い', async () => {
    const user = userEvent.setup();
    render(<UserSection />);
    const support = await rowOf('support@example.com');
    await user.click(within(support).getByRole('combobox'));
    const options = within(await screen.findByRole('listbox')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Admin', 'Support']);
    expect(calls('PATCH')).toHaveLength(0);
  });

  it('DD-AUTH-084 店員どうしの切り替えが 429 で断られたら、元の役割に戻して「しばらくしてから」を出す', async () => {
    respond = (_url, init) => (init?.method === 'PATCH' ? { status: 429, body: {} } : null);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<UserSection />);
    const support = await rowOf('support@example.com');
    const select = within(support).getByRole('combobox');
    await user.click(select);
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Admin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('しばらくしてからお試しください。');
    expect(select).toHaveTextContent('Support');
    consoleError.mockRestore();
  });
});

describe('DD-AUTH-084 やり直しのダイアログ', () => {
  async function openRedo() {
    const user = userEvent.setup();
    render(<UserSection />);
    const support = await rowOf('support@example.com');
    await user.click(within(support).getByRole('button', { name: 'パスキーを全部消してやり直す' }));
    const dialog = await screen.findByRole('dialog', { name: 'パスキーを全部消してやり直す' });
    return { user, dialog, send: within(dialog).getByRole('button', { name: 'やり直しを送る' }) };
  }

  it('DD-AUTH-084 確認の語が違うと送れない', async () => {
    const { user, dialog, send } = await openRedo();
    await user.type(within(dialog).getByLabelText(/確認のため/), 'やりなおし');
    await user.type(within(dialog).getByLabelText(/理由/), '鍵を紛失したため、再登録が要る');
    expect(send).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls('POST')).toHaveLength(0);
  });

  it('DD-AUTH-084 理由が9字だと送れず、10字で送れる', async () => {
    const { user, dialog, send } = await openRedo();
    await user.type(within(dialog).getByLabelText(/確認のため/), 'やり直し');
    await user.type(within(dialog).getByLabelText(/理由/), '123456789');
    expect(send).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/理由/), '0');
    expect(send).toBeEnabled();
  });

  it('DD-AUTH-084 送ると redo を呼び、送信中は disabled と aria-busy、成功で閉じる', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockFetch.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        await gate;
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      if (String(url) === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ user: { id: ADMIN_ME } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ data: users }) } as Response;
    });
    const { user, dialog, send } = await openRedo();
    await user.type(within(dialog).getByLabelText(/確認のため/), 'やり直し');
    await user.type(within(dialog).getByLabelText(/理由/), '鍵を紛失したため、再登録が要る');
    await user.click(send);
    await waitFor(() => expect(send).toHaveAttribute('aria-busy', 'true'));
    expect(send).toBeDisabled();
    // 送っている間は Escape でも閉じない
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    release?.();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const post = calls('POST')[0];
    expect(post[0]).toBe(`/api/admin/staff/${SUPPORTER}/redo`);
    expect(JSON.parse(String(post[1]?.body))).toEqual({ confirm: 'やり直し', reason: '鍵を紛失したため、再登録が要る' });
  });

  it('DD-AUTH-084 失敗は LiveMessage に出し、ダイアログは開いたまま（メールの送り失敗は 502 の文）', async () => {
    respond = (_url, init) => (init?.method === 'POST' ? { status: 502, body: { code: 'mail_failed' } } : null);
    const { user, dialog, send } = await openRedo();
    await user.type(within(dialog).getByLabelText(/確認のため/), 'やり直し');
    await user.type(within(dialog).getByLabelText(/理由/), '鍵を紛失したため、再登録が要る');
    await user.click(send);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('メールを送れませんでした。もう一度、招待を出してください。');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('DD-AUTH-084 招待・取り消し・店員にする', () => {
  it('DD-AUTH-084 招待を送っている間は Escape でも閉じない', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockFetch.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        await gate;
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
      }
      if (String(url) === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ user: { id: ADMIN_ME } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ data: users }) } as Response;
    });
    const user = userEvent.setup();
    render(<UserSection />);
    await user.click(await screen.findByRole('button', { name: '店員を招待' }));
    const dialog = await screen.findByRole('dialog', { name: '店員を招待' });
    await user.type(within(dialog).getByLabelText(/メールアドレス/), 'new@example.com');
    await user.click(within(dialog).getByRole('button', { name: '招待を送る' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '招待を送る' })).toHaveAttribute('aria-busy', 'true'));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    release?.();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('DD-AUTH-084 お客さんに戻すが 503 の時は、ログアウトにせず「しばらくしてから」の文を出す', async () => {
    respond = (_url, init) => (init?.method === 'POST' ? { status: 503, body: { error: 'x' } } : null);
    const user = userEvent.setup();
    render(<UserSection />);
    const support = await rowOf('support@example.com');
    await user.click(within(support).getByRole('button', { name: 'お客さんに戻す' }));
    const dialog = await screen.findByRole('dialog', { name: 'お客さんに戻す' });
    await user.click(within(dialog).getByRole('button', { name: 'お客さんに戻す' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('しばらくしてからお試しください。');
  });

  it('DD-AUTH-084 招待中の行に「招待中」と取り消しが出て、取り消すと invite/cancel を呼ぶ', async () => {
    const user = userEvent.setup();
    render(<UserSection />);
    const invited = await rowOf('invited@example.com');
    expect(within(invited).getByText('招待中')).toBeInTheDocument();
    expect(within(await rowOf('customer@example.com')).queryByText('招待中')).not.toBeInTheDocument();
    await user.click(within(invited).getByRole('button', { name: '招待を取り消す' }));
    await waitFor(() => expect(calls('POST')).toHaveLength(1));
    expect(calls('POST')[0][0]).toBe(`/api/admin/staff/${INVITED}/invite/cancel`);
  });

  it('DD-AUTH-084 「店員を招待」でメールと役割を送り、503 はログアウトにせず「しばらくしてから」の文を出す', async () => {
    respond = (url, init) => (init?.method === 'POST' && url === '/api/admin/staff/invites' ? { status: 503, body: { code: 'config' } } : null);
    const user = userEvent.setup();
    render(<UserSection />);
    await user.click(await screen.findByRole('button', { name: '店員を招待' }));
    const dialog = await screen.findByRole('dialog', { name: '店員を招待' });
    await user.type(within(dialog).getByLabelText(/メールアドレス/), 'new@example.com');
    await user.selectOptions(within(dialog).getByLabelText('役割'), 'admin');
    await user.click(within(dialog).getByRole('button', { name: '招待を送る' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('しばらくしてからお試しください。');
    expect(JSON.parse(String(calls('POST')[0][1]?.body))).toEqual({ email: 'new@example.com', role: 'admin' });
  });

  it('DD-AUTH-084 すでに店員への招待は 409 の文を出す', async () => {
    respond = (url, init) => (init?.method === 'POST' && url === '/api/admin/staff/invites' ? { status: 409, body: { code: 'already_staff' } } : null);
    const user = userEvent.setup();
    render(<UserSection />);
    await user.click(await screen.findByRole('button', { name: '店員を招待' }));
    const dialog = await screen.findByRole('dialog', { name: '店員を招待' });
    await user.type(within(dialog).getByLabelText(/メールアドレス/), 'support@example.com');
    await user.click(within(dialog).getByRole('button', { name: '招待を送る' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください。',
    );
  });

  it('DD-AUTH-084 お客さんを店員にするは確認の後に PATCH し、役割はすぐには変わらず、502 は送れなかった文', async () => {
    respond = (_url, init) => (init?.method === 'PATCH' ? { status: 502, body: { code: 'mail_failed' } } : null);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<UserSection />);
    const customer = await rowOf('customer@example.com');
    await user.click(within(customer).getByRole('combobox'));
    await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Support' }));
    const dialog = await screen.findByRole('dialog', { name: '店員にする' });
    expect(calls('PATCH')).toHaveLength(0);
    expect(dialog).toHaveTextContent('招待のメールを送ります');
    await user.click(within(dialog).getByRole('button', { name: '店員にする' }));
    expect(await screen.findByText('メールを送れませんでした。もう一度、招待を出してください。')).toBeInTheDocument();
    expect(within(customer).getByRole('combobox')).toHaveTextContent('User');
    consoleError.mockRestore();
  });
});
