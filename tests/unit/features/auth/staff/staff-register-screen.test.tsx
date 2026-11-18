import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import StaffRegisterScreen from '@/features/auth/staff/components/StaffRegisterScreen';

const mockReplace = jest.fn();
const mockRegister = jest.fn();
const mockComplete = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
jest.mock('@/features/auth/passkey/passkey-client', () => ({
  registerPasskey: (...a: unknown[]) => mockRegister(...a),
}));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({ requestAttestation: jest.fn() }));
jest.mock('@/features/auth/staff/staff-register-client', () => ({
  completeStaffRegistration: (...a: unknown[]) => mockComplete(...a),
}));

const passkey = { id: 'pk', friendly_name: null, created_at: '2026-11-18T00:00:00Z' };
const created = { ok: true, passkey, nameApplied: true };

const KEY1 = '1本目を登録';
const KEY2 = '2本目を登録';
const COMPLETE = '登録を完了する';
const ADVICE = '別の端末か、セキュリティキーでの登録をおすすめします。';

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

beforeEach(() => {
  mockReplace.mockReset();
  mockRegister.mockReset();
  mockComplete.mockReset();
});

describe('DD-AUTH-080 /staff/register の画面', () => {
  test('DD-AUTH-080 見出しと1本目の段を出し、2本目のおすすめと完了のボタンはまだ出さない', () => {
    render(<StaffRegisterScreen initialRegistered={0} />);
    expect(screen.getByRole('heading', { name: 'パスキーを2本登録してください' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: KEY1 })).toBeInTheDocument();
    expect(screen.queryByText(ADVICE)).toBeNull();
    expect(screen.queryByRole('button', { name: COMPLETE })).toBeNull();
    expect(screen.queryByRole('button', { name: KEY2 })).toBeNull();
  });

  test('DD-AUTH-080 1本目を登録すると、2本目の前におすすめの文を出す', async () => {
    mockRegister.mockResolvedValue(created);
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    expect(await screen.findByText(ADVICE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: KEY2 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: KEY1 })).toBeNull();
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  test('DD-AUTH-080 1本だけで「登録を完了する」を押すと、窓口の 409 を「あと1本、登録してください。」にする', async () => {
    mockRegister.mockResolvedValue(created);
    mockComplete.mockResolvedValue({ ok: false, reason: 'keys_short' });
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    await click(COMPLETE);
    expect(await screen.findByText('あと1本、登録してください。')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: KEY2 })).toBeInTheDocument();
  });

  test('DD-AUTH-080 2本目を登録すると自動で完了を呼び、完了の文と「ログインへ」を出す', async () => {
    mockRegister.mockResolvedValue(created);
    mockComplete.mockResolvedValue({ ok: true, redirectTo: '/login' });
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    await click(KEY2);
    expect(await screen.findByText('登録が終わりました。パスキーでログインしてください。')).toBeInTheDocument();
    expect(mockComplete).toHaveBeenCalledTimes(1);
    await click('ログインへ');
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  test('DD-AUTH-080 すでに2本ある時（再読み込み）は、登録のボタンを出さず完了だけ出す', () => {
    render(<StaffRegisterScreen initialRegistered={2} />);
    expect(screen.queryByRole('button', { name: KEY1 })).toBeNull();
    expect(screen.queryByRole('button', { name: KEY2 })).toBeNull();
    expect(screen.getByRole('button', { name: COMPLETE })).toBeInTheDocument();
  });

  test('DD-AUTH-080 窓口が窓の外と答えたら、時間が過ぎた文だけにして、ボタンを消す', async () => {
    mockRegister.mockResolvedValue({ ok: false, reason: 'window_closed' });
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    expect(await screen.findByText('時間が過ぎました。店長に、もう一度招待を出してもらってください。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: KEY1 })).toBeNull();
  });

  test('DD-AUTH-080 2本目の直後に窓が閉じていた時は、ボタンが無くても落ちず、時間が過ぎた文を出す', async () => {
    mockRegister.mockResolvedValue(created);
    mockComplete.mockResolvedValue({ ok: false, reason: 'window_closed' });
    render(<StaffRegisterScreen initialRegistered={1} />);
    await click(KEY2);
    expect(await screen.findByText('時間が過ぎました。店長に、もう一度招待を出してもらってください。')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('DD-AUTH-080 完了の窓口が 403（window_closed）でも同じ文', async () => {
    mockComplete.mockResolvedValue({ ok: false, reason: 'window_closed' });
    render(<StaffRegisterScreen initialRegistered={2} />);
    await click(COMPLETE);
    expect(await screen.findByText('時間が過ぎました。店長に、もう一度招待を出してもらってください。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: COMPLETE })).toBeNull();
  });

  test('DD-AUTH-080 窓口が「2本を超える」と答えたら（reauth_required）、画面で数えず完了を呼ぶ', async () => {
    mockRegister.mockResolvedValue({ ok: false, reason: 'reauth_required' });
    mockComplete.mockResolvedValue({ ok: true, redirectTo: '/login' });
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    await waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('登録が終わりました。パスキーでログインしてください。')).toBeInTheDocument();
  });

  test('DD-AUTH-080 keys_not_window は、もう一度招待を出してもらう文', async () => {
    mockComplete.mockResolvedValue({ ok: false, reason: 'keys_not_window' });
    render(<StaffRegisterScreen initialRegistered={2} />);
    await click(COMPLETE);
    expect(await screen.findByText('店長に、もう一度招待を出してもらってください。')).toBeInTheDocument();
  });

  test.each([
    ['rate_limited', '試行が集中しています。しばらくしてからやり直してください。'],
    ['unavailable', 'ただいま完了できません。時間をおいてお試しください。'],
  ])('DD-AUTH-080 完了の失敗 %s は文を出し、ボタンを残す', async (reason, message) => {
    mockComplete.mockResolvedValue({ ok: false, reason });
    render(<StaffRegisterScreen initialRegistered={2} />);
    await click(COMPLETE);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COMPLETE })).toBeEnabled();
  });

  test('DD-AUTH-080 完了の呼びが例外でも、「うまく完了できませんでした」でボタンが戻る', async () => {
    mockComplete.mockRejectedValue(new Error('x'));
    render(<StaffRegisterScreen initialRegistered={2} />);
    await click(COMPLETE);
    expect(await screen.findByText('うまく完了できませんでした。もう一度お試しください。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COMPLETE })).toBeEnabled();
  });

  test('DD-AUTH-080 完了の失敗（failed・通信）は、ボタンを残して「もう一度」を促す', async () => {
    mockComplete.mockResolvedValue({ ok: false, reason: 'failed' });
    render(<StaffRegisterScreen initialRegistered={2} />);
    await click(COMPLETE);
    expect(await screen.findByText('うまく完了できませんでした。もう一度お試しください。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COMPLETE })).toBeInTheDocument();
  });

  test.each([
    ['cancelled', '登録を中止しました。もう一度お試しください。'],
    ['already_registered', 'この端末のパスキーは、すでに登録されています。別の端末か、セキュリティキーで登録してください。'],
    ['unsupported', 'この端末ではパスキーを登録できません。別の端末か、セキュリティキーでお試しください。'],
    ['rate_limited', '試行が集中しています。しばらくしてからやり直してください。'],
    ['unavailable', 'ただいま登録できません。時間をおいてお試しください。'],
    ['retry', 'うまく登録できませんでした。もう一度お試しください。'],
    ['failed', 'うまく登録できませんでした。もう一度お試しください。'],
  ])('DD-AUTH-080 登録の失敗 %s は文を出し、同じボタンを残す', async (reason, message) => {
    mockRegister.mockResolvedValue({ ok: false, reason });
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: KEY1 })).toBeEnabled();
  });

  test('DD-AUTH-080 unauthorized は窓が切れた文', async () => {
    mockRegister.mockResolvedValue({ ok: false, reason: 'unauthorized' });
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    expect(await screen.findByText('時間が過ぎました。店長に、もう一度招待を出してもらってください。')).toBeInTheDocument();
  });

  test('DD-AUTH-080 例外は「うまく登録できませんでした」で、ボタンが戻る', async () => {
    mockRegister.mockRejectedValue(new Error('x'));
    render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    expect(await screen.findByText('うまく登録できませんでした。もう一度お試しください。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: KEY1 })).toBeEnabled();
  });

  test('DD-AUTH-080 専門語・絵文字・感嘆符を画面に出さない', async () => {
    mockRegister.mockResolvedValue(created);
    const { container } = render(<StaffRegisterScreen initialRegistered={0} />);
    await click(KEY1);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/WebAuthn|認証器|UV|頁|!|！/);
  });
});
