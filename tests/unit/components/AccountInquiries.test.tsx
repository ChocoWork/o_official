import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountInquiries from '@/components/AccountInquiries';
import { clientFetch } from '@/lib/client-fetch';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));

const mockedFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const THREAD = {
  id: 't1',
  created_at: '2026-09-01T00:00:00Z',
  last_message_at: '2026-09-02T00:00:00Z',
  inquiry_type: 'order' as const,
  subject: '配送について',
  status: 'answered' as const,
};

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('AccountInquiries の返信の案内（FREQ-377）', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (url, options) => {
      if (url === '/api/contact/threads') return json({ data: [THREAD] });
      if (url === '/api/contact/threads/t1') {
        return json({ data: { ...THREAD, updated_at: THREAD.last_message_at, messages: [] } });
      }
      if (url === '/api/contact/threads/t1/reply' && options?.method === 'POST') return json({ ok: true });
      throw new Error(`unexpected ${url}`);
    });
  });

  it('返信を送ると、最初から置いた読み上げの入れ物に「返信を送信しました。」が入る', async () => {
    const user = userEvent.setup();
    render(<AccountInquiries />);

    await user.click(await screen.findByRole('button', { name: /配送について/ }));
    const region = await screen.findByRole('status');
    expect(region).toHaveTextContent('');

    await user.type(screen.getByRole('textbox', { name: '返信する' }), 'ありがとうございます');
    await user.click(screen.getByRole('button', { name: '返信を送信' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('返信を送信しました。'));
    // 案内ごと差し込み直さず、同じ入れ物の中身が変わる
    expect(screen.getByRole('status')).toBe(region);
  });
});
