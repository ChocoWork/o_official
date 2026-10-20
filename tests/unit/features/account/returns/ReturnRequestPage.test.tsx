import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'order-1' }) }));
let mockLogin = { isLoggedIn: true, isAuthResolved: true };
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => mockLogin }));
const mockFetchMaterials = jest.fn();
jest.mock('@/features/account/returns/customer-return-client', () => ({
  fetchCustomerReturnMaterials: (...args: unknown[]) => mockFetchMaterials(...args),
}));
// 3段の中身は ReturnRequestForm の試験で確かめる。ここでは、材料を渡して出すことだけを確かめる
jest.mock('@/features/account/returns/ReturnRequestForm', () => ({
  ReturnRequestForm: ({ materials }: { materials: { order: { id: string } } }) => <div data-testid="form-stub">{materials.order.id}</div>,
}));

import ReturnRequestPage from '@/app/account/orders/[id]/return/page';
import { materials, type Materials } from './return-request-fixtures';

const LOAD_FAILED = 'お申し込みの画面を読み込めませんでした。時間をおいて、もう一度お試しください。';
const NONE = 'この注文は、返品・交換のお申し込みを受け付けていません。';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ready(availability: Materials['availability']) {
  return { kind: 'ok', data: materials({ availability }) };
}

beforeEach(() => {
  mockLogin = { isLoggedIn: true, isAuthResolved: true };
  mockFetchMaterials.mockReset();
});

describe('お客様の返品・交換の申し込みの画面（ログインの確かめ）', () => {
  it('ログインの確かめが終わるまでは読み込み中の文だけを出し、材料は読まない', () => {
    mockLogin = { isLoggedIn: false, isAuthResolved: false };

    render(<ReturnRequestPage />);

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(mockFetchMaterials).not.toHaveBeenCalled();
  });

  it('ログインしていなければ、ログインが必要な旨とログインのボタンを出し、材料は読まない', () => {
    mockLogin = { isLoggedIn: false, isAuthResolved: true };

    render(<ReturnRequestPage />);

    expect(screen.getByRole('heading', { name: '返品・交換のお申し込み' })).toBeInTheDocument();
    expect(screen.getByText('お申し込みにはログインが必要です')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログイン' })).toHaveAttribute('href', '/login');
    expect(mockFetchMaterials).not.toHaveBeenCalled();
    expect(screen.queryByTestId('form-stub')).not.toBeInTheDocument();
  });
});

describe('お客様の返品・交換の申し込みの画面（材料の読み込み）', () => {
  it('ログイン済みなら、URL の注文の番号で材料を読み、読んでいる間は申し込みの中身を出さない。申し込める時は材料を渡して3段の部品を出す', async () => {
    const pending = deferred<unknown>();
    mockFetchMaterials.mockReturnValueOnce(pending.promise);

    render(<ReturnRequestPage />);

    expect(screen.getByRole('heading', { name: '返品・交換のお申し込み' })).toBeInTheDocument();
    expect(mockFetchMaterials).toHaveBeenCalledTimes(1);
    expect(mockFetchMaterials).toHaveBeenCalledWith('order-1');
    expect(screen.queryByTestId('form-stub')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '注文の画面に戻る' })).not.toBeInTheDocument();

    pending.resolve(ready({ returns: 'available', endedOn: null }));

    expect(await screen.findByTestId('form-stub')).toHaveTextContent('a1b2c3d4-1111-2222-8333-444455556666');
    expect(screen.queryByRole('link', { name: '注文の画面に戻る' })).not.toBeInTheDocument();
  });

  it('読み込めなかった時は、その旨を role="alert" で出し、注文の画面へ戻るボタンを出す', async () => {
    mockFetchMaterials.mockResolvedValueOnce({ kind: 'error', message: LOAD_FAILED, notFound: false });

    render(<ReturnRequestPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(screen.getByRole('link', { name: '注文の画面に戻る' })).toHaveAttribute('href', '/account/orders/order-1');
    expect(screen.queryByTestId('form-stub')).not.toBeInTheDocument();
  });

  it('注文が無い・持ち主でない（404）時は、注文の存在を明かさず「受け付けていません」の文を出す', async () => {
    mockFetchMaterials.mockResolvedValueOnce({ kind: 'error', message: LOAD_FAILED, notFound: true });

    render(<ReturnRequestPage />);

    expect(await screen.findByText(NONE)).toBeInTheDocument();
    expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '注文の画面に戻る' })).toBeInTheDocument();
  });

  it.each([
    [{ returns: 'closed', endedOn: null }, '現在、返品・交換のお申し込みを受け付けていません。'],
    [{ returns: 'ended', endedOn: '2026-10-11' }, '返品・交換の受付は 10月11日 で終わりました'],
    [{ returns: 'ended', endedOn: null }, NONE],
    [{ returns: 'none', endedOn: null }, NONE],
  ] as const)('申し込めない時（%j）は、その文と注文の画面へ戻るボタンだけを出す', async (availability, message) => {
    mockFetchMaterials.mockResolvedValueOnce(ready(availability));

    render(<ReturnRequestPage />);

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: '注文の画面に戻る' })).toHaveAttribute('href', '/account/orders/order-1');
    expect(screen.queryByTestId('form-stub')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
