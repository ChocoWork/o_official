import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AllocationSwapDialog from '@/components/AllocationSwapDialog';
import type { AdminOrderDetail } from '@/lib/orders/admin-orders/admin-order-types';
import { ALLOCATION_SWAP_ERRORS, ALLOCATION_SWAP_TEXT } from '@/lib/inventory/allocation-swap-types';
const mockCandidates = jest.fn();
const mockPost = jest.fn();
jest.mock('@/lib/inventory/allocation-swap-client', () => ({ fetchSwapCandidates: (...args: unknown[]) => mockCandidates(...args), postAllocationSwap: (...args: unknown[]) => mockPost(...args) }));
const id = 'a1b2c3d4-1111-4222-8333-444455556666';
const row: AdminOrderDetail['rows'][number] = { orderItemId: 'b1b2c3d4-1111-4222-8333-444455556666', itemName: 'ブラウス', color: '白', size: 'M', isExchange: false, status: 'in_production', statusRank: 3, quantity: 3, unitPrice: 100, lineAmount: 300, refundAmount: 0, blockedReasons: ['stock_shortage'] };
const candidate = { donorOrderId: 'c1b2c3d4-1111-4222-8333-444455556666', donorOrderItemId: 'd1b2c3d4-1111-4222-8333-444455556666', orderCreatedAt: '2026-10-20T01:00:00Z', swappableQuantity: 5, takerQuantity: 3 };
beforeEach(() => { mockCandidates.mockReset().mockResolvedValue({ kind: 'ok', data: [candidate, { ...candidate, donorOrderItemId: 'e1b2c3d4-1111-4222-8333-444455556666', swappableQuantity: 1 }] }); mockPost.mockReset(); });
async function open() {
  const onSwapped = jest.fn(); const onClose = jest.fn();
  render(<AllocationSwapDialog orderId={id} orderNumber="ORD-A1B2C3D4" row={row} onSwapped={onSwapped} onClose={onClose} />);
  await screen.findByRole('option', { name: /ORD-C1B2C3D4.*発送準備中 5/ });
  return { onSwapped, onClose };
}
it('FREQ-523-AC-05: 候補の読込・選択・数量上限・理由を検証する', async () => {
  await open();
  expect(mockCandidates).toHaveBeenCalledWith(id, row.orderItemId);
  const quantity = screen.getByRole('spinbutton', { name: '数量' });
  expect(quantity).toHaveValue(3); expect(quantity).toHaveAttribute('max', '3');
  fireEvent.change(screen.getByRole('combobox', { name: '割当元の注文' }), { target: { value: 'e1b2c3d4-1111-4222-8333-444455556666' } });
  expect(quantity).toHaveValue(1); expect(quantity).toHaveAttribute('max', '1');
  fireEvent.click(screen.getByRole('button', { name: '入れ替える' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('理由を入力してください。'); expect(mockPost).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: '理由' }), { target: { value: '急ぎのため' } });
  fireEvent.change(quantity, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: '入れ替える' }));
  expect(mockPost).not.toHaveBeenCalled();
});
it('FREQ-523-AC-05: 本文・二重押下・結果不明の同じ本文再確認・成功', async () => {
  let finish: (value: unknown) => void = () => {};
  mockPost.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ kind: 'ok', data: {} });
  const { onSwapped } = await open();
  fireEvent.change(screen.getByRole('textbox', { name: '理由' }), { target: { value: ' 急ぎのため ' } });
  const submit = screen.getByRole('button', { name: '入れ替える' }); fireEvent.click(submit); fireEvent.click(submit);
  expect(mockPost).toHaveBeenCalledTimes(1);
  const body = mockPost.mock.calls[0][1];
  expect(body).toEqual({ takerOrderItemId: row.orderItemId, donorOrderItemId: candidate.donorOrderItemId, quantity: 3, reason: '急ぎのため', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  await act(async () => finish({ kind: 'unknown' }));
  expect(screen.getByText(ALLOCATION_SWAP_TEXT.unknown)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '理由' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
  await waitFor(() => expect(onSwapped).toHaveBeenCalledTimes(1)); expect(mockPost.mock.calls[1]).toEqual([id, body]);
});
it('FREQ-523-AC-05: DBの断りは入力を残し新しい要求番号で送り直す', async () => {
  mockPost.mockResolvedValue({ kind: 'refused', message: ALLOCATION_SWAP_ERRORS.GROUP_G_SWAP_DONOR_ON_HOLD[2] });
  await open(); fireEvent.change(screen.getByRole('textbox', { name: '理由' }), { target: { value: '急ぎ' } });
  fireEvent.click(screen.getByRole('button', { name: '入れ替える' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(ALLOCATION_SWAP_ERRORS.GROUP_G_SWAP_DONOR_ON_HOLD[2]);
  expect(screen.getByRole('textbox', { name: '理由' })).toHaveValue('急ぎ');
  fireEvent.click(screen.getByRole('button', { name: '入れ替える' }));
  await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
  expect(mockPost.mock.calls[1][1].requestKey).not.toBe(mockPost.mock.calls[0][1].requestKey);
});
it.each([{ kind: 'ok', data: [], text: ALLOCATION_SWAP_TEXT.candidatesEmpty }, { kind: 'error', message: ALLOCATION_SWAP_TEXT.candidatesFailed, text: ALLOCATION_SWAP_TEXT.candidatesFailed }])('FREQ-523-AC-05: 候補の空と失敗を表示する %#', async (result) => {
  mockCandidates.mockResolvedValue(result);
  render(<AllocationSwapDialog orderId={id} orderNumber="ORD-A1B2C3D4" row={row} onSwapped={jest.fn()} onClose={jest.fn()} />);
  expect(screen.getByText(ALLOCATION_SWAP_TEXT.candidatesLoading)).toBeInTheDocument();
  expect(await screen.findByText(result.text)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '入れ替える' })).not.toBeInTheDocument();
});
