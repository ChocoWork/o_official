import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShipmentSlipDateDialog from '@/components/ShipmentSlipDateDialog';
import { clientFetch } from '@/lib/client-fetch';
import { SLIP_ID } from '../lib/orders/shipment-slips/shipment-slip-fixtures';
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);
const slip = { id: SLIP_ID, version: 2, shipmentDate: '2026-10-25' };
const result = { id: SLIP_ID, version: 3, shipmentDate: '2026-10-24', replayed: false };
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
function setup() {
  const handlers = { onClose: jest.fn(), onCorrected: jest.fn(), onStale: jest.fn() };
  return { ...render(<ShipmentSlipDateDialog slip={slip} {...handlers} />), ...handlers };
}
function fill() {
  fireEvent.change(screen.getByLabelText('新しい出荷日'), { target: { value: '2026-10-24' } });
  fireEvent.change(screen.getByLabelText('理由'), { target: { value: ' 記録の訂正 ' } });
}
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(json(result)); });
test('FREQ-535-AC-03: 正式な見出し・説明・現在の日付・必須の理由', async () => {
  setup();
  expect(within(screen.getByRole('dialog', { name: '出荷日を訂正する' })).getByText('お客様の返品期限は変わりません。')).toBeVisible();
  expect(screen.getByLabelText('新しい出荷日')).toHaveValue(slip.shipmentDate);
  expect(screen.getByLabelText('理由')).toBeRequired();
  await userEvent.click(screen.getByRole('button', { name: '訂正する' }));
  expect(screen.getByRole('alert')).toHaveTextContent('理由を入力してください。');
  expect(fetchMock).not.toHaveBeenCalled();
});
test('FREQ-535-AC-03: 201文字は送らず200文字は通る', async () => {
  setup(); fill();
  fireEvent.change(screen.getByLabelText('理由'), { target: { value: 'あ'.repeat(201) } });
  await userEvent.click(screen.getByRole('button', { name: '訂正する' }));
  expect(fetchMock).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('入力を確かめてください。');
  fireEvent.change(screen.getByLabelText('理由'), { target: { value: ` ${'あ'.repeat(200)} ` } });
  await userEvent.click(screen.getByRole('button', { name: '訂正する' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});
test('FREQ-535-AC-03: 二重押下は1要求、理由trim・現在の版・uuid、成功通知', async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = setup(); fill();
  fireEvent.click(screen.getByRole('button', { name: '訂正する' }));
  fireEvent.click(screen.getByRole('button', { name: '訂正する' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('理由')).toBeDisabled();
  expect(fetchMock.mock.calls[0][0]).toBe(`/api/admin/shipment-slips/${SLIP_ID}/shipment-date`);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ expectedVersion: 2, shipmentDate: '2026-10-24', reason: '記録の訂正', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
  await act(async () => resolve(json(result)));
  expect(view.onCorrected).toHaveBeenCalledTimes(1);
});
test('FREQ-535-AC-03: 版競合で入力を保ち、再読込後の版と新しいキーで送る', async () => {
  fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_SLIP_VERSION_CONFLICT' }, 409));
  const view = setup(); fill();
  await userEvent.click(screen.getByRole('button', { name: '訂正する' }));
  await waitFor(() => expect(view.onStale).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
  expect(screen.getByLabelText('理由')).toHaveValue(' 記録の訂正 ');
  view.rerender(<ShipmentSlipDateDialog slip={{ ...slip, version: 3 }} onClose={view.onClose} onCorrected={view.onCorrected} onStale={view.onStale} />);
  await userEvent.click(screen.getByRole('button', { name: '訂正する' }));
  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[1]).toMatchObject({ expectedVersion: 3, reason: '記録の訂正' });
  expect(bodies[1].requestKey).not.toBe(bodies[0].requestKey);
});
test('FREQ-535-AC-03: 結果不明は同じ本文とキーで再確認し、二重訂正を防ぐ', async () => {
  fetchMock.mockRejectedValueOnce(new Error('network'));
  setup(); fill(); await userEvent.click(screen.getByRole('button', { name: '訂正する' }));
  await userEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
});
