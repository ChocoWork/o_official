import { act, fireEvent, render, screen } from '@testing-library/react';
jest.mock('@/features/order-status/status-client', () => ({ submitOrderStatusLastFour: jest.fn() }));
import { submitOrderStatusLastFour } from '@/features/order-status/status-client';
import { OrderStatusVerifyForm } from '@/features/order-status/components/OrderStatusVerifyForm';
import { ORDER_STATUS_ERROR_MESSAGES as ERR } from '@/lib/orders/status/status-messages';

function setup() {
  const onVerified = jest.fn(); const onUnavailable = jest.fn();
  render(<OrderStatusVerifyForm token={'t'.repeat(43)} onVerified={onVerified} onUnavailable={onUnavailable} />);
  return { input: screen.getByRole('textbox', { name: 'ご注文の時の電話番号の下4桁' }), onVerified, onUnavailable };
}
const response = (status: number, body: object) => ({ status, ok: status === 200, json: async () => body }) as Response;
beforeEach(() => jest.clearAllMocks());

test('確認欄の固定文と入力属性を関連付ける', () => {
  const { input } = setup();
  for (const text of ['お届け先などの確認', 'お届け先・お支払い方法・伝票番号を見るには、ご注文の時の電話番号の下4桁を入れてください。', '数字4桁を入れてください。']) expect(screen.getByText(text)).toBeVisible();
  expect(input).toHaveAttribute('type', 'text'); expect(input).toHaveAttribute('inputmode', 'numeric');
  expect(input).toHaveAttribute('autocomplete', 'off'); expect(input).toHaveAttribute('maxlength', '64');
  expect(input).toHaveAttribute('placeholder', '1234'); expect(input).toHaveAccessibleDescription('数字4桁を入れてください。');
});

test.each(['123', '12345'])('桁数が違う入力は送信せず固定文を出す（%s桁）', async (value) => {
  const { input } = setup(); fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
  expect(await screen.findByText(ERR.ORDER_STATUS_INPUT_INVALID)).toBeVisible();
  expect(submitOrderStatusLastFour).not.toHaveBeenCalled();
});

test('全角は切り捨てず受け、成功で入力を消し、二重押しを止める', async () => {
  let resolve: (value: Response) => void = () => undefined;
  jest.mocked(submitOrderStatusLastFour).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const { input, onVerified } = setup();
  fireEvent.change(input, { target: { value: '１２３４' } });
  const form = input.closest('form');
  if (!form) throw new Error('form missing');
  fireEvent.submit(form); fireEvent.submit(form);
  expect(screen.getByRole('button', { name: '確認中…' })).toBeDisabled(); expect(input).toBeDisabled();
  expect(submitOrderStatusLastFour).toHaveBeenCalledTimes(1);
  expect(jest.mocked(submitOrderStatusLastFour).mock.calls[0][1] === '1234').toBe(true);
  await act(async () => resolve(response(200, { ok: true, expiresAt: '2026-10-23T00:00:00Z' })));
  expect((input as HTMLInputElement).value.length === 0).toBe(true);
  expect(onVerified).toHaveBeenCalledWith('2026-10-23T00:00:00Z');
  expect(screen.getByText('確認できました。')).toBeVisible();
});

test.each([
  [400, 'ORDER_STATUS_MISMATCH'], [429, 'ORDER_STATUS_RATE_LIMITED'], [500, 'ORDER_STATUS_FAILED'],
  [503, 'ORDER_STATUS_TEMPORARILY_UNAVAILABLE'], [403, 'ORDER_STATUS_FORBIDDEN'], [404, 'ORDER_STATUS_NOT_FOUND'],
] as const)('%sは固定文を出して再試行できる', async (status, code) => {
  jest.mocked(submitOrderStatusLastFour).mockResolvedValueOnce(response(status, { code, error: 'opaque' }));
  const { input } = setup(); fireEvent.change(input, { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
  expect(await screen.findByText(ERR[code])).toBeVisible();
  expect(screen.getByRole('button', { name: '確かめる' })).toBeEnabled();
  expect(document.body.textContent?.includes('opaque')).toBe(false);
});

test.each([
  [400, 'ORDER_STATUS_MISMATCH', 'locked'], [423, 'ORDER_STATUS_LOCKED', 'locked'],
  [410, 'ORDER_STATUS_EXPIRED', 'expired'], [409, 'ORDER_STATUS_UNAVAILABLE', 'unavailable'],
] as const)('%sの確認不能は親へ渡す（%s）', async (status, code, reason) => {
  jest.mocked(submitOrderStatusLastFour).mockResolvedValueOnce(response(status, { code, verifiable: false, reason }));
  const { input, onUnavailable } = setup(); fireEvent.change(input, { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
  await screen.findByText(ERR[reason === 'locked' ? 'ORDER_STATUS_LOCKED' : code]);
  expect(onUnavailable).toHaveBeenCalledWith({ verifiable: false, reason });
});

test('通信失敗の後も手動で再試行して復帰できる', async () => {
  jest.mocked(submitOrderStatusLastFour).mockRejectedValueOnce(new TypeError('opaque')).mockResolvedValueOnce(response(200, { ok: true, expiresAt: '2026-10-23T00:00:00Z' }));
  const { input, onVerified } = setup(); fireEvent.change(input, { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: '確かめる' })); await screen.findByText(ERR.ORDER_STATUS_FAILED);
  fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
  await screen.findByText('確認できました。'); expect(onVerified).toHaveBeenCalledTimes(1);
});
