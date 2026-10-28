import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ContactSection from '@/components/ContactSection';
import { clientFetch } from '@/lib/client-fetch';

/**
 * 管理のお問い合わせ画面（ContactSection）の書き込みが 429 で断られた時（波 4 Task 1b）。
 * 回数の制限の 429 は no-store で返る。本文を使わなくても読み始めないと、ブラウザが要求を開いたまま残す。
 */

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));

const mockedFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const THREAD = {
  id: 't1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  last_message_at: '2026-09-02T00:00:00Z',
  name: '山田',
  email: 'yamada@example.test',
  inquiry_type: 'order' as const,
  subject: '配送について',
  status: 'open' as const,
  order_id: null,
};

const TEMPLATE = { id: 'tp1', title: '挨拶', category: 'general' as const, body: 'お世話になっております。', sort_order: 1 };

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 429。本文は使われない。arrayBuffer が呼ばれたかを見る */
function limited(): { response: Response; drain: jest.Mock } {
  const drain = jest.fn(async () => new ArrayBuffer(0));
  return {
    response: { ok: false, status: 429, json: async () => ({ error: 'Too many requests' }), arrayBuffer: drain } as unknown as Response,
    drain,
  };
}

let writeResponse: Response;

beforeEach(() => {
  mockedFetch.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockedFetch.mockImplementation(async (url, options) => {
    const method = (options?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return writeResponse;
    if (typeof url === 'string' && url.startsWith('/api/admin/contact/templates')) return json({ data: [TEMPLATE] });
    if (url === '/api/admin/contact/t1') {
      return json({ data: { ...THREAD, message: '本文', orderNumber: null, messages: [] } });
    }
    if (typeof url === 'string' && url.startsWith('/api/admin/contact?')) {
      return json({ data: [THREAD], totalPages: 1, totalCount: 1 });
    }
    throw new Error(`unexpected ${String(url)}`);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ContactSection の 429（本文は使わない）でも本文を読み始める', () => {
  it('返信の送信が 429 の時', async () => {
    const { response, drain } = limited();
    writeResponse = response;
    render(<ContactSection />);

    fireEvent.click(await screen.findByRole('button', { name: /配送について/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '返信内容' }), { target: { value: 'ご連絡します' } });
    fireEvent.click(screen.getByRole('button', { name: '返信を送信' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('返信の送信に失敗しました。'));
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('ステータスの変更が 429 の時', async () => {
    const { response, drain } = limited();
    writeResponse = response;
    render(<ContactSection />);

    fireEvent.click(await screen.findByRole('button', { name: /配送について/ }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'ステータス変更' }));
    fireEvent.click(await screen.findByRole('option', { name: 'クローズ' }));

    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
  });

  it('返信テンプレートの保存（POST）が 429 の時', async () => {
    const { response, drain } = limited();
    writeResponse = response;
    render(<ContactSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'テンプレート管理' }));
    fireEvent.change(await screen.findByLabelText('タイトル'), { target: { value: '新しい挨拶' } });
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
  });

  it('返信テンプレートの削除が 429 の時', async () => {
    const { response, drain } = limited();
    writeResponse = response;
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ContactSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'テンプレート管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));

    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
  });
});
