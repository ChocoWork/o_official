/** @jest-environment node */
import { resolveLocalMailUrl, sendMail } from '@/lib/mail/adapters/local';

describe('手元のメール受け（Mailpit）への送信', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv, MAIL_FROM_ADDRESS: 'no-reply@e2e.test' };
    delete process.env.MAIL_LOCAL_URL;
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ID: 'abc' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('既定の口（127.0.0.1:54324）の送信 API に、件名・本文・返信先を渡す', async () => {
    await expect(
      sendMail({ to: 'shop@e2e.test', subject: '件名', text: '本文', replyTo: 'reply@e2e.test' }),
    ).resolves.toEqual({ ID: 'abc' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:54324/api/v1/send');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      From: { Email: 'no-reply@e2e.test' },
      To: [{ Email: 'shop@e2e.test' }],
      Subject: '件名',
      Text: '本文',
      ReplyTo: [{ Email: 'reply@e2e.test' }],
    });
  });

  it('MAIL_LOCAL_URL があればその口に送り、html だけのメールも送れる', async () => {
    process.env.MAIL_LOCAL_URL = 'http://localhost:55555';
    await sendMail({ to: 'a@e2e.test', subject: 's', html: '<p>h</p>' });

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:55555/api/v1/send');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ HTML: '<p>h</p>' });
    expect(body).not.toHaveProperty('Text');
    expect(body).not.toHaveProperty('ReplyTo');
  });

  it('手元でない住所には送らない（メールを外へ出さない）', async () => {
    process.env.MAIL_LOCAL_URL = 'https://mail.example.com';
    await expect(sendMail({ to: 'a@e2e.test', subject: 's', text: 't' })).rejects.toThrow(
      'MAIL_LOCAL_URL must point to localhost',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('メール受けが 2xx 以外を返したら失敗にする', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    await expect(sendMail({ to: 'a@e2e.test', subject: 's', text: 't' })).rejects.toThrow(
      'Local mail send failed: HTTP 400',
    );
  });

  it('本文が無ければ送らない', async () => {
    await expect(sendMail({ to: 'a@e2e.test', subject: 's' })).rejects.toThrow(
      'Either html or text must be provided',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('差出人が無ければ手元用の既定の差出人を使う', async () => {
    delete process.env.MAIL_FROM_ADDRESS;
    await sendMail({ to: 'a@e2e.test', subject: 's', text: 't' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).From).toEqual({ Email: 'no-reply@localhost.test' });
  });

  it('::1 も手元として受け付ける', () => {
    expect(resolveLocalMailUrl('http://[::1]:54324').hostname).toBe('[::1]');
  });
});
