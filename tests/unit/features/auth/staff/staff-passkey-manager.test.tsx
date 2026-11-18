/**
 * @jest-environment jsdom
 */
/**
 * DD-AUTH-082 店員のパスキー管理（一覧・名前・追加・削除。src/features/auth/staff/components/StaffPasskeyManager.tsx）
 * 削除の下限は窓口と同じ数え方（認めた鍵を消して認めた本数が2本未満になるなら止める。認めていない鍵は常に消せる）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StaffPasskeyManager from '@/features/auth/staff/components/StaffPasskeyManager';

const mockLoad = jest.fn();
const mockRename = jest.fn();
const mockDelete = jest.fn();
const mockRegister = jest.fn();
const mockSupported = jest.fn();

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
jest.mock('@/features/auth/staff/staff-passkey-status', () => ({ loadStaffPasskeys: (...a: unknown[]) => mockLoad(...a) }));
jest.mock('@/features/auth/passkey/passkey-client', () => ({
  renamePasskey: (...a: unknown[]) => mockRename(...a),
  deletePasskey: (...a: unknown[]) => mockDelete(...a),
  registerPasskey: (...a: unknown[]) => mockRegister(...a),
}));
jest.mock('@/features/auth/passkey/webauthn-browser', () => ({
  isPasskeySupported: () => mockSupported(),
  requestAttestation: jest.fn(),
}));

const key = (id: string, name: string | null, approved = true, lastUsed: string | null = null) => ({
  id,
  friendly_name: name,
  created_at: '2026-11-17T20:00:00Z',
  last_used_at: lastUsed,
  approved,
});

function status(passkeys: ReturnType<typeof key>[]) {
  return { ok: true, isStaff: true, approvedCount: passkeys.filter((p) => p.approved).length, passkeys };
}

async function renderWith(passkeys: ReturnType<typeof key>[]) {
  mockLoad.mockResolvedValue(status(passkeys));
  const view = render(<StaffPasskeyManager />);
  await waitFor(() => expect(screen.queryByTestId('staff-passkeys-loading')).not.toBeInTheDocument());
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSupported.mockReturnValue(true);
  mockDelete.mockResolvedValue({ ok: true });
  mockRename.mockResolvedValue({ ok: true, passkey: { id: 'a', friendly_name: '新しい名前' } });
});

describe('DD-AUTH-082 StaffPasskeyManager', () => {
  test('DD-AUTH-082 一覧に名前・作成日・最後に使った日を日本時間で出す。専門語は出さず、「パスキー」は言い換えを添える', async () => {
    await renderWith([key('a', 'Mac', true, '2026-11-18T01:00:00Z'), key('b', null)]);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Mac')).toBeInTheDocument();
    expect(within(items[0]).getByText('2026年11月18日 に作成')).toBeInTheDocument();
    expect(within(items[0]).getByText('最後に使った日: 2026年11月18日')).toBeInTheDocument();
    expect(within(items[1]).getByText('名前なし')).toBeInTheDocument();
    expect(screen.getByText(/顔認証・指紋・PIN で入る方法/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/WebAuthn|認証器|頁|!|！/);
  });

  test('DD-AUTH-082 認めた鍵が2本のとき、認めた鍵の削除は止まる（ボタンは無効で、理由の文を出す）', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone')]);
    for (const item of screen.getAllByRole('listitem')) {
      expect(within(item).getByRole('button', { name: /を削除/ })).toBeDisabled();
      expect(within(item).getByText(/パスキーは2本以上必要です。先に別のパスキーを登録してください。/)).toBeInTheDocument();
    }
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('DD-AUTH-082 認めた鍵が3本なら削除できる。確認のあと deletePasskey を呼び、一覧を引き直す', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone'), key('c', 'Key')]);
    const first = screen.getAllByRole('listitem')[0];
    fireEvent.click(within(first).getByRole('button', { name: 'Macを削除' }));
    mockLoad.mockResolvedValue(status([key('b', 'iPhone'), key('c', 'Key')]));
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('a'));
    expect(await screen.findByText('パスキーを削除しました。')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  });

  test('DD-AUTH-082 認めていない鍵は、認めた鍵が2本でも消せる（疑わしい鍵を外せる）', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone'), key('x', '知らない鍵', false)]);
    const unapproved = screen.getAllByRole('listitem')[2];
    expect(within(unapproved).getByRole('button', { name: '知らない鍵を削除' })).toBeEnabled();
    expect(within(unapproved).getByText(/この鍵ではログインできません/)).toBeInTheDocument();
    fireEvent.click(within(unapproved).getByRole('button', { name: '知らない鍵を削除' }));
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('x'));
  });

  test('DD-AUTH-082 認めた鍵が1本のときも、認めた鍵の削除は止まる', async () => {
    await renderWith([key('a', 'Mac')]);
    expect(screen.getByRole('button', { name: 'Macを削除' })).toBeDisabled();
  });

  test('DD-AUTH-082 窓口が削除を断ったら（409 など）、失敗の文を出し、一覧を引き直す', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone'), key('c', 'Key')]);
    mockDelete.mockResolvedValue({ ok: false, reason: 'failed' });
    fireEvent.click(screen.getByRole('button', { name: 'Macを削除' }));
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    expect(await screen.findByText('削除できませんでした。認めた鍵は2本以上が必要です。')).toBeInTheDocument();
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(2));
  });

  test.each([
    ['rate_limited', 'ただいま処理できません。しばらくしてからお試しください。'],
    ['unavailable', 'ただいま処理できません。しばらくしてからお試しください。'],
    ['not_found', 'このパスキーは見つかりません。一覧を読み込み直しました。'],
    ['unauthorized', 'ログインの有効期限が切れました。もう一度ログインしてください。'],
  ])('DD-AUTH-082 削除の失敗 %s は、下限の文ではなく状態に合った文を出す', async (reason, text) => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone'), key('c', 'Key')]);
    mockDelete.mockResolvedValue({ ok: false, reason });
    fireEvent.click(screen.getByRole('button', { name: 'Macを削除' }));
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText('削除できませんでした。認めた鍵は2本以上が必要です。')).toBeNull();
  });

  test('DD-AUTH-082 名前を変えられる', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone')]);
    fireEvent.click(screen.getByRole('button', { name: 'Macの名前を変更' }));
    const input = screen.getByLabelText('名前');
    fireEvent.change(input, { target: { value: '新しい名前' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mockRename).toHaveBeenCalledWith('a', '新しい名前'));
    expect(await screen.findByText('新しい名前')).toBeInTheDocument();
  });

  test('DD-AUTH-082 追加が通ると一覧を引き直し、完了の文を出す', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone')]);
    mockRegister.mockResolvedValue({ ok: true, passkey: { id: 'c' }, nameApplied: true });
    mockLoad.mockResolvedValue(status([key('a', 'Mac'), key('b', 'iPhone'), key('c', 'Key')]));
    fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    expect(await screen.findByText('パスキーを追加しました。')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
  });

  test('DD-AUTH-082 追加が reauth_required なら、「安全のため、もう一度パスキーでログインしてから追加してください。」とログインし直すリンクを出す', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone')]);
    mockRegister.mockResolvedValue({ ok: false, reason: 'reauth_required' });
    fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    expect(await screen.findByText('安全のため、もう一度パスキーでログインしてから追加してください。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'パスキーでログインし直す' })).toHaveAttribute('href', '/login?next=%2Fadmin%2Fpasskeys');
  });

  test('DD-AUTH-082 一覧が読めなければ文と「再読み込み」。読めない間は何も消さない', async () => {
    mockLoad.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    render(<StaffPasskeyManager />);
    expect(await screen.findByText('パスキーの一覧を読み込めませんでした。')).toBeInTheDocument();
    mockLoad.mockResolvedValueOnce(status([key('a', 'Mac')]));
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(await screen.findByText('Mac')).toBeInTheDocument();
  });

  test.each([
    ['cancelled', 'パスキーの作成を中止しました。'],
    ['already_registered', 'この端末のパスキーは、すでに登録されています。別の端末か、セキュリティキーで登録してください。'],
    ['unsupported', 'この端末ではパスキーを作れません。'],
    ['rate_limited', '試行が集中しています。しばらくしてからやり直してください。'],
    ['unavailable', 'ただいまパスキーを作れません。時間をおいてお試しください。'],
    ['failed', 'うまく作れませんでした。もう一度お試しください。'],
  ])('DD-AUTH-082 追加の失敗 %s の文を出す', async (reason, message) => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone')]);
    mockRegister.mockResolvedValue({ ok: false, reason });
    fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'パスキーを追加' })).toBeEnabled();
  });

  test('DD-AUTH-082 追加が unauthorized なら「ログインへ」のリンク。追加が例外でも失敗の文', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone')]);
    mockRegister.mockResolvedValueOnce({ ok: false, reason: 'unauthorized' });
    fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    expect(await screen.findByRole('link', { name: 'ログインへ' })).toHaveAttribute('href', '/login');
    mockRegister.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'パスキーを追加' }));
    expect(await screen.findByText('うまく作れませんでした。もう一度お試しください。')).toBeInTheDocument();
  });

  test('DD-AUTH-082 名前の長さが外れたら保存せず文を出し、キャンセルで元に戻る。変更の失敗も文を出す', async () => {
    await renderWith([key('a', null), key('b', 'iPhone')]);
    fireEvent.click(screen.getByRole('button', { name: '名前なしの名前を変更' }));
    const input = screen.getByRole('textbox', { name: '名前' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('名前は1〜64字（日本語は40字まで）で入力してください。')).toBeInTheDocument();
    expect(mockRename).not.toHaveBeenCalled();
    mockRename.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    fireEvent.change(input, { target: { value: '新しい名前' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('名前を変更できませんでした。もう一度お試しください。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('textbox', { name: '名前' })).not.toBeInTheDocument();
    expect(screen.getByText('名前なし')).toBeInTheDocument();
  });

  test('DD-AUTH-082 削除の確認をやめると、何も消さない', async () => {
    await renderWith([key('a', 'Mac'), key('b', 'iPhone'), key('c', 'Key')]);
    fireEvent.click(screen.getByRole('button', { name: 'Macを削除' }));
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('DD-AUTH-082 対応していないブラウザでは追加が無効', async () => {
    mockSupported.mockReturnValue(false);
    await renderWith([key('a', 'Mac'), key('b', 'iPhone')]);
    expect(screen.getByRole('button', { name: 'パスキーを追加' })).toBeDisabled();
  });
});
