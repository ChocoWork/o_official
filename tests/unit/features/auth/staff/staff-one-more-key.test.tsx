/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-082 認めた鍵が1本の店員の「もう1本」の画面（src/features/auth/staff/components/StaffOneMoreKey.tsx）
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StaffOneMoreKey from '@/features/auth/staff/components/StaffOneMoreKey';

const mockReplace = jest.fn();
const mockRegister = jest.fn();
const mockSupported = jest.fn();
const mockRefreshOnce = jest.fn();
const mockRefreshAuthState = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => ({ refreshAuthState: mockRefreshAuthState }) }));
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn(), refreshSessionOnce: () => mockRefreshOnce() }));
jest.mock('@/features/auth/passkey/passkey-client', () => ({ registerPasskey: (...a: unknown[]) => mockRegister(...a) }));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({
  isPasskeySupported: () => mockSupported(),
  requestAttestation: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSupported.mockReturnValue(true);
  mockRefreshOnce.mockResolvedValue('refreshed');
  mockRefreshAuthState.mockResolvedValue(undefined);
});

describe('DD-AUTH-082 StaffOneMoreKey', () => {
  test('DD-AUTH-082 見出し・説明・「2本目を登録」。専門語を出さず、おすすめの文を添える', () => {
    render(<StaffOneMoreKey />);
    expect(screen.getByRole('heading', { name: 'あと1本、登録してください' })).toBeInTheDocument();
    expect(screen.getByText(/顔認証・指紋・PIN で入る方法/)).toBeInTheDocument();
    expect(screen.getByText('別の端末か、セキュリティキーでの登録をおすすめします。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2本目を登録' })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/WebAuthn|認証器|頁|!|！/);
  });

  test('DD-AUTH-082 登録が通ると、ログインの印を更新して、/admin へ移る', async () => {
    mockRegister.mockResolvedValue({ ok: true, passkey: { id: 'k' }, nameApplied: true });
    render(<StaffOneMoreKey />);
    fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
    expect(mockRefreshOnce).toHaveBeenCalledTimes(1);
    expect(mockRefreshAuthState).toHaveBeenCalledTimes(1);
  });

  test('DD-AUTH-082 印の更新ができなければ /admin へは移らず、文とリンクを出す（登録は済んでいる）', async () => {
    mockRegister.mockResolvedValue({ ok: true, passkey: { id: 'k' }, nameApplied: true });
    mockRefreshOnce.mockResolvedValue('unavailable');
    render(<StaffOneMoreKey />);
    fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    expect(await screen.findByText('登録できました。もう一度パスキーでログインしてください。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('DD-AUTH-082 reauth_required は「安全のため、もう一度パスキーでログインしてから追加してください。」と「パスキーでログインし直す」', async () => {
    mockRegister.mockResolvedValue({ ok: false, reason: 'reauth_required' });
    render(<StaffOneMoreKey />);
    fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    expect(await screen.findByText('安全のため、もう一度パスキーでログインしてから追加してください。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスキーでログインし直す' })).toHaveAttribute('href', '/login?next=%2Fadmin%2Fpasskeys');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test.each([
    ['cancelled', '登録を中止しました。もう一度お試しください。'],
    ['already_registered', 'この端末のパスキーは、すでに登録されています。別の端末か、セキュリティキーで登録してください。'],
    ['unavailable', 'ただいま登録できません。時間をおいてお試しください。'],
    ['unsupported', 'この端末ではパスキーを登録できません。別の端末か、セキュリティキーでお試しください。'],
    ['rate_limited', '試行が集中しています。しばらくしてからやり直してください。'],
    ['failed', 'うまく登録できませんでした。もう一度お試しください。'],
  ])('DD-AUTH-082 %s の文を出し、ボタンはまた押せる', async (reason, message) => {
    mockRegister.mockResolvedValue({ ok: false, reason });
    render(<StaffOneMoreKey />);
    fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2本目を登録' })).toBeEnabled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('DD-AUTH-082 登録が例外を投げても失敗の文を出し、ボタンはまた押せる', async () => {
    mockRegister.mockRejectedValue(new Error('boom'));
    render(<StaffOneMoreKey />);
    fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    expect(await screen.findByText('うまく登録できませんでした。もう一度お試しください。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2本目を登録' })).toBeEnabled();
  });

  test('DD-AUTH-082 unauthorized は「ログインへ」のリンク', async () => {
    mockRegister.mockResolvedValue({ ok: false, reason: 'unauthorized' });
    render(<StaffOneMoreKey />);
    fireEvent.click(screen.getByRole('button', { name: '2本目を登録' }));
    expect(await screen.findByText('もう一度ログインしてください。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
  });

  test('DD-AUTH-082 対応していないブラウザではボタンが無効で、一文を出す', () => {
    mockSupported.mockReturnValue(false);
    render(<StaffOneMoreKey />);
    expect(screen.getByRole('button', { name: '2本目を登録' })).toBeDisabled();
    expect(screen.getByText('この端末ではパスキーを登録できません。別の端末か、セキュリティキーでお試しください。')).toBeInTheDocument();
  });
});
