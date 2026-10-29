import { fireEvent, render, screen } from '@testing-library/react';
import DiscountFormScreen from '@/features/discounts/components/DiscountFormScreen';
import { failResponse, okResponse } from './discount-test-utils';
const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
beforeEach(() => mockFetch.mockReset());
test('FREQ-543-AC-03: 新規作成もmanageを確かめてからフォームを出す', async () => {
  mockFetch.mockResolvedValue(okResponse({ data: { rows: [], total: 0 }, permissions: { read: true, manage: false } }));
  render(<DiscountFormScreen />);
  expect(screen.queryByRole('form', { name: '割引を作る' })).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('割引を操作する権限がありません。');
  expect(screen.queryByRole('button', { name: '作成する' })).not.toBeInTheDocument();
});
test('FREQ-543-AC-03: 新規作成の確認失敗を読み直し、manageがあればフォームを出す', async () => {
  mockFetch.mockResolvedValueOnce(failResponse(503)).mockResolvedValueOnce(okResponse({ data: { rows: [], total: 0 }, permissions: { read: true, manage: true } }));
  render(<DiscountFormScreen />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }));
  expect(await screen.findByRole('button', { name: '作成する' })).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledWith('/api/admin/discounts?page=1', { cache: 'no-store' });
});
