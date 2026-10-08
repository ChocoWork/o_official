import React from 'react';
import { render } from '@testing-library/react';
import { CartLoginSync } from '@/contexts/CartLoginSync';

const mockRefreshShopping = jest.fn();
// 画面が読むログインの状態。テストが書き換えて、再描画で画面に見せる。
// isAuthResolved は最初のログインの確認が済んだか（false 始まりの isLoggedIn が会員で true に変わるのを、ログインと取り違えないため）
let mockIsLoggedIn = false;
let mockIsAuthResolved = true;
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: mockIsLoggedIn, isAuthResolved: mockIsAuthResolved }),
}));
jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ refreshShopping: mockRefreshShopping }),
}));

describe('CartLoginSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLoggedIn = false;
    mockIsAuthResolved = true;
  });

  test.each([false, true])('最初の表示（ログイン中: %s）では読み直さない', (loggedIn) => {
    mockIsLoggedIn = loggedIn;
    render(<CartLoginSync />);

    expect(mockRefreshShopping).not.toHaveBeenCalled();
  });

  test('ログイン（false から true）で1回だけ読み直し、同じ状態の再表示では読み直さない', () => {
    const { rerender } = render(<CartLoginSync />);

    mockIsLoggedIn = true;
    rerender(<CartLoginSync />);
    expect(mockRefreshShopping).toHaveBeenCalledTimes(1);

    rerender(<CartLoginSync />);
    expect(mockRefreshShopping).toHaveBeenCalledTimes(1);
  });

  test('ログアウト（true から false）で1回だけ読み直す', () => {
    mockIsLoggedIn = true;
    const { rerender } = render(<CartLoginSync />);
    expect(mockRefreshShopping).not.toHaveBeenCalled();

    mockIsLoggedIn = false;
    rerender(<CartLoginSync />);

    expect(mockRefreshShopping).toHaveBeenCalledTimes(1);
  });

  test('ログインとログアウトを繰り返すたびに、1回ずつ読み直す', () => {
    const { rerender } = render(<CartLoginSync />);

    mockIsLoggedIn = true;
    rerender(<CartLoginSync />);
    mockIsLoggedIn = false;
    rerender(<CartLoginSync />);

    expect(mockRefreshShopping).toHaveBeenCalledTimes(2);
  });

  test('最初のログインの確認が済んで会員と分かっただけ（false から true）では読み直さない', () => {
    // 画面を開いた時の読み込みがカートとお気に入りを会員の分で読むので、ここで重ねて読まない
    mockIsAuthResolved = false;
    const { rerender } = render(<CartLoginSync />);

    mockIsLoggedIn = true;
    mockIsAuthResolved = true;
    rerender(<CartLoginSync />);

    expect(mockRefreshShopping).not.toHaveBeenCalled();

    // その後のログアウトは読み直す
    mockIsLoggedIn = false;
    rerender(<CartLoginSync />);
    expect(mockRefreshShopping).toHaveBeenCalledTimes(1);
  });
});
