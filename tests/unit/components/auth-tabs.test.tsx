import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthTabs from '@/components/AuthTabs';

jest.mock('@/components/LoginModal', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => (
    <div data-testid="login-modal" data-open={String(open)} />
  ),
}));

jest.mock('@/components/RegisterModal', () => ({
  __esModule: true,
  default: ({
    onSwitchToLogin,
    initialEmail,
  }: {
    onSwitchToLogin?: () => void;
    initialEmail?: string;
  }) => (
    <div data-testid="register-modal" data-initial-email={initialEmail ?? ''}>
      <button type="button" onClick={onSwitchToLogin}>
        mock-switch-to-login
      </button>
    </div>
  ),
}));

describe('AuthTabs', () => {
  let replaceStateSpy: jest.SpyInstance;

  beforeEach(() => {
    replaceStateSpy = jest.spyOn(window.history, 'replaceState');
  });

  afterEach(() => {
    replaceStateSpy.mockRestore();
  });

  it('DD-AUTH-010 初めのタブを状態に入れ、2つのタブと tabpanel を描く', () => {
    render(<AuthTabs initialTab="login" />);

    const tablist = screen.getByRole('tablist', { name: 'ログイン / 会員登録' });
    const tabs = screen.getAllByRole('tab');
    expect(tablist).toBeInTheDocument();
    expect(tabs.map((tab) => tab.textContent)).toEqual(['ログイン', '会員登録']);

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'auth-panel');
    expect(panel).toHaveAttribute('aria-labelledby', 'auth-tab-login');
    tabs.forEach((tab) => expect(tab).toHaveAttribute('aria-controls', 'auth-panel'));
  });

  it('DD-AUTH-010 初めのタブがログインなら LoginModal をいつも開いた形で出す', () => {
    render(<AuthTabs initialTab="login" initialEmail="a@example.com" />);

    expect(screen.getByTestId('login-modal')).toHaveAttribute('data-open', 'true');
    expect(screen.queryByTestId('register-modal')).toBeNull();
  });

  it('DD-AUTH-010 初めのタブが会員登録なら RegisterModal にメールの初めの値を渡す', () => {
    render(<AuthTabs initialTab="register" initialEmail="a@example.com" />);

    expect(screen.getByTestId('register-modal')).toHaveAttribute(
      'data-initial-email',
      'a@example.com',
    );
    expect(screen.queryByTestId('login-modal')).toBeNull();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'auth-tab-register');
  });

  it('DD-AUTH-010 メールの初めの値が無ければ空のまま RegisterModal に渡す', () => {
    render(<AuthTabs initialTab="register" />);

    expect(screen.getByTestId('register-modal')).toHaveAttribute('data-initial-email', '');
  });

  it('DD-AUTH-010 選んだタブだけを Tab キーで止まる所にし、黒い太い下線・黒い文字にする', () => {
    render(<AuthTabs initialTab="login" />);
    const login = screen.getByRole('tab', { name: 'ログイン' });
    const register = screen.getByRole('tab', { name: '会員登録' });

    expect(login).toHaveAttribute('aria-selected', 'true');
    expect(login).toHaveAttribute('tabindex', '0');
    expect(login.className).toContain('border-b-2');
    expect(login.className).toContain('text-black');

    expect(register).toHaveAttribute('aria-selected', 'false');
    expect(register).toHaveAttribute('tabindex', '-1');
    expect(register.className).toContain('border-black/20');
    expect(register.className).toContain('text-[#737373]');
    expect(register.className).not.toContain('border-b-2');
  });

  it('DD-AUTH-010 タブを押すと切り替わり、URL を /login に置き換える', async () => {
    const user = userEvent.setup();
    render(<AuthTabs initialTab="login" />);

    await user.click(screen.getByRole('tab', { name: '会員登録' }));

    expect(screen.getByTestId('register-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('login-modal')).toBeNull();
    expect(screen.getByRole('tab', { name: '会員登録' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('tabindex', '-1');
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/login');
    expect(window.location.pathname).toBe('/login');

    await user.click(screen.getByRole('tab', { name: 'ログイン' }));
    expect(screen.getByTestId('login-modal')).toBeInTheDocument();
    expect(replaceStateSpy).toHaveBeenCalledTimes(2);
  });

  it('DD-AUTH-010 URL の問い合わせ（?tab= ?email=）は切り替えで消える', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', '/login?tab=register&email=a%40example.com');
    replaceStateSpy.mockClear();
    render(<AuthTabs initialTab="register" initialEmail="a@example.com" />);

    await user.click(screen.getByRole('tab', { name: 'ログイン' }));

    expect(window.location.pathname).toBe('/login');
    expect(window.location.search).toBe('');
  });

  it('DD-AUTH-010 押したタブが今のタブなら何もしない', async () => {
    const user = userEvent.setup();
    render(<AuthTabs initialTab="login" />);

    await user.click(screen.getByRole('tab', { name: 'ログイン' }));

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('login-modal')).toBeInTheDocument();
  });

  it('DD-AUTH-010 会員登録の「ログインへ戻る」でログインのタブへ切り替わる', async () => {
    const user = userEvent.setup();
    render(<AuthTabs initialTab="register" />);

    await user.click(screen.getByRole('button', { name: 'mock-switch-to-login' }));

    expect(screen.getByTestId('login-modal')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'ログイン' })).toHaveAttribute('aria-selected', 'true');
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/login');
  });

  it('DD-AUTH-010 右の矢印でもう1つのタブへ切り替え、そのタブにフォーカスを移す', () => {
    render(<AuthTabs initialTab="login" />);
    const login = screen.getByRole('tab', { name: 'ログイン' });
    login.focus();

    fireEvent.keyDown(login, { key: 'ArrowRight' });

    const register = screen.getByRole('tab', { name: '会員登録' });
    expect(register).toHaveAttribute('aria-selected', 'true');
    expect(register).toHaveFocus();
    expect(screen.getByTestId('register-modal')).toBeInTheDocument();
  });

  it('DD-AUTH-010 左の矢印でもう1つのタブへ切り替え、そのタブにフォーカスを移す', () => {
    render(<AuthTabs initialTab="register" />);
    const register = screen.getByRole('tab', { name: '会員登録' });
    register.focus();

    fireEvent.keyDown(register, { key: 'ArrowLeft' });

    const login = screen.getByRole('tab', { name: 'ログイン' });
    expect(login).toHaveAttribute('aria-selected', 'true');
    expect(login).toHaveFocus();
    expect(screen.getByTestId('login-modal')).toBeInTheDocument();
  });

  it('DD-AUTH-010 矢印は既定の動き（スクロール）を止める', () => {
    render(<AuthTabs initialTab="login" />);
    const login = screen.getByRole('tab', { name: 'ログイン' });

    const notPrevented = fireEvent.keyDown(login, { key: 'ArrowRight' });

    expect(notPrevented).toBe(false);
  });

  it('DD-AUTH-010 左右の矢印以外のキーは何もしない', () => {
    render(<AuthTabs initialTab="login" />);
    const login = screen.getByRole('tab', { name: 'ログイン' });

    const notPrevented = fireEvent.keyDown(login, { key: 'Enter' });
    fireEvent.keyDown(login, { key: 'ArrowDown' });

    expect(notPrevented).toBe(true);
    expect(screen.getByTestId('login-modal')).toBeInTheDocument();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});
