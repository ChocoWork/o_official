import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
jest.mock('@/contexts/LoginContext', () => ({ useLogin: () => mockAuth }));
jest.mock('@/features/order-status/status-client', () => ({ fetchOrderStatusPrivate: jest.fn(), submitOrderStatusLastFour: jest.fn() }));
import { OrderStatusAccess } from '@/features/order-status/components/OrderStatusAccess';
import { fetchOrderStatusPrivate, submitOrderStatusLastFour } from '@/features/order-status/status-client';
import { SESSION_EXPIRED_EVENT } from '@/lib/client-fetch';
import { ORDER_STATUS_ERROR_MESSAGES as ERR } from '@/lib/orders/status/status-messages';
import type { CustomerOrderPrivateView } from '@/lib/orders/customer-order-view-types';

const mockAuth = { isLoggedIn: false, isAuthResolved: true };
const privateData: CustomerOrderPrivateView = { shipping: { fullName: 'PRIVATE_SENTINEL', postalCode: '', address: '', phone: '' }, contactEmail: '', paymentMethod: '', shipments: [], returns: [] };
const none = { access: 'none', verifiable: true, reason: null };
const response = (body: object, status = 200) => ({ ok: status === 200, status, json: async () => body }) as Response;
const element = () => <><h1>公開注文</h1><OrderStatusAccess token={'t'.repeat(43)} orderId="order" orderNumber="ORD-1234ABCD" publicReturns={[]} /></>;
const privatePresent = () => document.body.textContent?.includes('PRIVATE_SENTINEL') ?? false;
beforeEach(() => { jest.clearAllMocks(); mockAuth.isLoggedIn = false; mockAuth.isAuthResolved = true; jest.mocked(fetchOrderStatusPrivate).mockResolvedValue(response(none)); });
afterEach(() => { jest.useRealTimers(); });

test('GETのnoneは確認欄、memberとverifiedは指定の個人情報だけ', async () => {
  const renderedAccesses: string[] = [];
  for (const access of ['none', 'member', 'verified'] as const) {
    jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response(access === 'none' ? none : { access, data: privateData, expiresAt: access === 'verified' ? new Date(Date.now() + 86400000).toISOString() : null }));
    const mounted = render(element());
    if (access === 'none') { await screen.findByRole('textbox'); renderedAccesses.push('form'); }
    else { await screen.findByRole('heading', { name: 'お届け先' }); renderedAccesses.push(privatePresent() ? `private-${access}` : 'missing'); }
    mounted.unmount();
  }
  expect(renderedAccesses).toEqual(['form', 'private-member', 'private-verified']);
});

test('認証状態が確定するまでGETせず、ログインだけで認可しない', async () => {
  mockAuth.isAuthResolved = false; mockAuth.isLoggedIn = true;
  const { rerender } = render(element()); expect(fetchOrderStatusPrivate).not.toHaveBeenCalled();
  mockAuth.isAuthResolved = true; rerender(element()); await screen.findByRole('textbox');
  expect(privatePresent()).toBe(false); expect(screen.queryByRole('link', { name: '会員の注文のページへ' })).not.toBeInTheDocument();
});

test('期限と未ログインへの変化で個人情報を捨てる', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'verified', data: privateData, expiresAt: '2026-10-23T00:00:00Z' }));
  const { rerender } = render(element()); await act(async () => undefined); expect(privatePresent()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(86400000 - 1); }); expect(privatePresent()).toBe(true);
  jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => new Promise(() => undefined));
  await act(async () => { jest.advanceTimersByTime(1); }); expect(privatePresent()).toBe(false);
  expect(screen.getByRole('heading', { name: '公開注文' })).toBeVisible();
  mockAuth.isLoggedIn = true;
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'member', data: privateData, expiresAt: null }));
  rerender(element()); await act(async () => undefined); expect(privatePresent()).toBe(true);
  mockAuth.isLoggedIn = false; jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => new Promise(() => undefined));
  rerender(element()); expect(privatePresent()).toBe(false);
});

test('古い読取の返事が後から届いても個人情報を戻さない', async () => {
  let finish: (value: Response) => void = () => undefined;
  jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(element()); const signal = jest.mocked(fetchOrderStatusPrivate).mock.calls[0][1];
  await act(async () => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)); }); await screen.findByRole('textbox');
  await act(async () => { finish(response({ access: 'member', data: privateData, expiresAt: null })); });
  expect(privatePresent()).toBe(false); expect(screen.getByRole('textbox')).toBeVisible(); expect(signal?.aborted).toBe(true);
});

test('未ログイン通知は表示済みの個人情報を直ちに捨てる', async () => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'member', data: privateData, expiresAt: null }));
  render(element()); await screen.findByRole('heading', { name: 'お届け先' });
  jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => new Promise(() => undefined));
  act(() => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)); });
  expect(privatePresent()).toBe(false); expect(screen.getByRole('heading', { name: '公開注文' })).toBeVisible();
  expect(screen.queryByRole('link', { name: '会員の注文のページへ' })).not.toBeInTheDocument();
});

test('ログアウトの描画はeffectが動く前から個人情報を含まない', async () => {
  mockAuth.isLoggedIn = true;
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'member', data: privateData, expiresAt: null }));
  let presentAtCommit = false;
  function InspectCommit() { useLayoutEffect(() => { presentAtCommit = privatePresent(); }); return null; }
  const mounted = render(<>{element()}<InspectCommit /></>);
  await screen.findByRole('heading', { name: 'お届け先' });
  mockAuth.isLoggedIn = false;
  jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => new Promise(() => undefined));
  mounted.rerender(<>{element()}<InspectCommit /></>);
  expect(presentAtCommit).toBe(false);
});

test('DBの短い期限でも境界で消し、既に期限切れのGETは再読込ループを作らない', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  const body = { access: 'verified', data: privateData, expiresAt: '2026-10-22T00:01:00Z' };
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValue(response(body));
  render(element()); await act(async () => undefined); expect(privatePresent()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(59999); }); expect(privatePresent()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(1); }); expect(privatePresent()).toBe(false);
  expect(screen.getByText(ERR.ORDER_STATUS_EXPIRED)).toBeVisible();
  expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(2);
});

test('unmountで確認期限のtimerも捨てる', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValue(response({ access: 'verified', data: privateData, expiresAt: '2026-10-23T00:00:00Z' }));
  const mounted = render(element()); await act(async () => undefined); mounted.unmount();
  await act(async () => { jest.advanceTimersByTime(86400000); });
  expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(1);
});

test.each(['expired', 'unavailable', 'locked'] as const)('noneの%sは確認欄を外し固定案内を出す', async (reason) => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'none', verifiable: false, reason }));
  render(element()); await screen.findByText(ERR[`ORDER_STATUS_${reason.toUpperCase()}` as keyof typeof ERR]);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(screen.getByRole('link', { name: 'ログインする' })).toHaveAttribute('href', '/login');
});

test('401後の公開維持と無限再読込無し', async () => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValue(response({ ...none, code: 'ORDER_STATUS_AUTH_REQUIRED', error: 'Unauthorized' }, 401));
  render(element()); await screen.findByText(ERR.ORDER_STATUS_AUTH_REQUIRED); await screen.findByRole('textbox');
  expect(screen.getByRole('heading', { name: '公開注文' })).toBeVisible(); expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(1);
});

test.each(['expired', 'unavailable', 'locked'] as const)('401でも%sの理由を使い確認欄を外す', async (reason) => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'none', verifiable: false, reason, code: 'ORDER_STATUS_AUTH_REQUIRED' }, 401));
  render(element()); await screen.findByText(ERR[`ORDER_STATUS_${reason.toUpperCase()}` as keyof typeof ERR]);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '公開注文' })).toBeVisible(); expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(1);
});

test.each([500, 503, 'network'] as const)('%sは再読込ボタンから復帰する', async (status) => {
  if (status === 'network') jest.mocked(fetchOrderStatusPrivate).mockRejectedValueOnce(new TypeError('opaque'));
  else jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ error: 'opaque' }, status));
  render(element()); fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  await screen.findByRole('textbox'); expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(2); expect(privatePresent()).toBe(false);
});

test('画面へ戻った時に読み直し、unmountで購読と読取を外す', async () => {
  const mounted = render(element()); await screen.findByRole('textbox');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(2);
  const signal = jest.mocked(fetchOrderStatusPrivate).mock.calls[1][1]; mounted.unmount();
  await act(async () => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)); document.dispatchEvent(new Event('visibilitychange')); });
  expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(2); expect(signal?.aborted).toBe(true);
});

// ---- J-16: 同じ文脈の読み直しでは表示と下4桁の欄を残し、文脈が変わる・期限が来る時はすぐ消す ----
const TOKEN_B = 'u'.repeat(43);
const at = (token = 't'.repeat(43), orderId = 'order') => <><h1>公開注文</h1><OrderStatusAccess token={token} orderId={orderId} orderNumber="ORD-1234ABCD" publicReturns={[]} /></>;
const member = () => response({ access: 'member', data: privateData, expiresAt: null });
function deferred<T>() { let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function showAgain(): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
}
const typedDigits = () => (document.querySelector('input[name="lastFour"]') as HTMLInputElement | null)?.value ?? '';

test('同じ文脈の読み直しの答え待ちの間は個人情報を残し、答えのnoneに従って消す（J-16）', async () => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(member());
  render(element()); await screen.findByRole('heading', { name: 'お届け先' });
  const later = deferred<Response>(); jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => later.promise);
  await showAgain();
  expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(2);
  expect(privatePresent()).toBe(true);
  await act(async () => { later.resolve(response(none)); });
  expect(privatePresent()).toBe(false); expect(screen.getByRole('textbox')).toBeVisible();
});

test('読み直しの答え待ちの間と答えの後も、下4桁の欄は同じ要素で入力した数字を残す（J-16）', async () => {
  render(element()); const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: '56' } });
  const later = deferred<Response>(); jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => later.promise);
  await showAgain();
  expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('textbox')).toBe(input); expect(input).toHaveValue('56');
  expect(screen.getByRole('link', { name: 'ログインする' })).toBeVisible();
  await act(async () => { later.resolve(response(none)); });
  expect(screen.getByRole('textbox')).toBe(input); expect(input).toHaveValue('56');
});

test.each([
  ['401', () => Promise.resolve(response({ ...none, code: 'ORDER_STATUS_AUTH_REQUIRED' }, 401))],
  ['locked', () => Promise.resolve(response({ access: 'none', verifiable: false, reason: 'locked' }))],
  ['expired', () => Promise.resolve(response({ access: 'none', verifiable: false, reason: 'expired' }))],
  ['unavailable', () => Promise.resolve(response({ access: 'none', verifiable: false, reason: 'unavailable' }))],
  ['503', () => Promise.resolve(response({ error: 'opaque' }, 503))],
  ['network', () => Promise.reject(new TypeError('opaque'))],
] as const)('読み直しの答えが%sなら残していた個人情報を消す（J-16）', async (_kind, reply) => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(member());
  render(element()); await screen.findByRole('heading', { name: 'お届け先' });
  jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(reply);
  await showAgain();
  expect(privatePresent()).toBe(false);
  expect(screen.getByRole('heading', { name: '公開注文' })).toBeVisible();
});

test('読み直しの答え待ちの間に確認の期限が来たら、個人情報をすぐ消す（J-16）', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'verified', data: privateData, expiresAt: '2026-10-22T00:01:00Z' }));
  render(element()); await act(async () => undefined); expect(privatePresent()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(30000); });
  jest.mocked(fetchOrderStatusPrivate).mockImplementation(() => new Promise(() => undefined));
  await showAgain(); expect(privatePresent()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(29999); }); expect(privatePresent()).toBe(true);
  await act(async () => { jest.advanceTimersByTime(1); }); expect(privatePresent()).toBe(false);
  expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(3);
});

test('画面へ戻った時に表示中の確認の期限が既に過ぎていれば、読み直しの答えを待たずに消す（J-16）', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'verified', data: privateData, expiresAt: '2026-10-22T00:01:00Z' }));
  render(element()); await act(async () => undefined); expect(privatePresent()).toBe(true);
  // 端末が眠っている間は期限のtimerが進まないことがある。時計だけ進めて戻る。
  jest.setSystemTime(new Date('2026-10-22T00:02:00Z'));
  jest.mocked(fetchOrderStatusPrivate).mockImplementation(() => new Promise(() => undefined));
  await showAgain();
  expect(privatePresent()).toBe(false);
});

test('読み直しの答え待ちの間にログアウトしたら、effectより前の描画から個人情報を含まない（J-16）', async () => {
  mockAuth.isLoggedIn = true;
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(member());
  let presentAtCommit = true;
  function InspectCommit() { useLayoutEffect(() => { presentAtCommit = privatePresent(); }); return null; }
  const mounted = render(<>{element()}<InspectCommit /></>);
  await screen.findByRole('heading', { name: 'お届け先' });
  jest.mocked(fetchOrderStatusPrivate).mockImplementation(() => new Promise(() => undefined));
  await showAgain(); expect(privatePresent()).toBe(true);
  mockAuth.isLoggedIn = false;
  mounted.rerender(<>{element()}<InspectCommit /></>);
  expect(presentAtCommit).toBe(false); expect(privatePresent()).toBe(false);
});

test('読み直しの答え待ちの間にセッションが切れたら、個人情報をすぐ消す（J-16）', async () => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(member());
  render(element()); await screen.findByRole('heading', { name: 'お届け先' });
  jest.mocked(fetchOrderStatusPrivate).mockImplementation(() => new Promise(() => undefined));
  await showAgain(); expect(privatePresent()).toBe(true);
  act(() => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)); });
  expect(privatePresent()).toBe(false);
});

test.each([
  ['別のtoken', () => at(TOKEN_B)],
  ['別の注文', () => at(undefined, 'other-order')],
] as const)('%sへ変わった描画は、読み直し中でもeffectより前から個人情報を含まない（J-16）', async (_kind, next) => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(member());
  let presentAtCommit = true;
  function InspectCommit() { useLayoutEffect(() => { presentAtCommit = privatePresent(); }); return null; }
  const mounted = render(<>{at()}<InspectCommit /></>);
  await screen.findByRole('heading', { name: 'お届け先' });
  jest.mocked(fetchOrderStatusPrivate).mockImplementation(() => new Promise(() => undefined));
  await showAgain(); expect(privatePresent()).toBe(true);
  mounted.rerender(<>{next()}<InspectCommit /></>);
  expect(presentAtCommit).toBe(false); expect(privatePresent()).toBe(false);
});

test('別のtokenへ変わった描画は、effectより前から個人情報も入力した数字も含まない（J-16）', async () => {
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(member());
  let atCommit = { present: true, digits: 'unset' };
  function InspectCommit() { useLayoutEffect(() => { atCommit = { present: privatePresent(), digits: typedDigits() }; }); return null; }
  const mounted = render(<>{at()}<InspectCommit /></>);
  await screen.findByRole('heading', { name: 'お届け先' });
  jest.mocked(fetchOrderStatusPrivate).mockImplementation(() => new Promise(() => undefined));
  mounted.rerender(<>{at(TOKEN_B)}<InspectCommit /></>);
  expect(atCommit.present).toBe(false);
  // 下4桁の欄: 古いリンクで入れた数字を新しいリンクへ持ち越さない
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValue(response(none));
  mounted.rerender(<>{at()}<InspectCommit /></>);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '56' } });
  jest.mocked(fetchOrderStatusPrivate).mockImplementation(() => new Promise(() => undefined));
  mounted.rerender(<>{at(TOKEN_B)}<InspectCommit /></>);
  expect(atCommit.digits).toBe('');
});

test('古いtokenの読取の返事が後から届いても、新しいリンクへ個人情報を出さない（J-16）', async () => {
  const first = deferred<Response>(); jest.mocked(fetchOrderStatusPrivate).mockImplementationOnce(() => first.promise);
  const mounted = render(at()); const signal = jest.mocked(fetchOrderStatusPrivate).mock.calls[0][1];
  mounted.rerender(at(TOKEN_B)); await screen.findByRole('textbox');
  await act(async () => { first.resolve(member()); });
  expect(privatePresent()).toBe(false); expect(screen.getByRole('textbox')).toBeVisible(); expect(signal?.aborted).toBe(true);
});

test.each([
  ['成功', () => response({ ok: true, expiresAt: '2026-10-23T00:00:00Z' })],
  ['ロック', () => response({ code: 'ORDER_STATUS_MISMATCH', verifiable: false, reason: 'locked' }, 400)],
] as const)('古い文脈の確認のPOSTの%sが後から届いても、新しい文脈へ反映しない（J-16）', async (_kind, reply) => {
  const mounted = render(at()); const input = await screen.findByRole('textbox');
  const post = deferred<Response>(); jest.mocked(submitOrderStatusLastFour).mockImplementationOnce(() => post.promise);
  fireEvent.change(input, { target: { value: '1234' } }); fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
  mounted.rerender(at(TOKEN_B)); await screen.findByRole('textbox');
  const calls = jest.mocked(fetchOrderStatusPrivate).mock.calls.length;
  await act(async () => { post.resolve(reply()); });
  expect(jest.mocked(fetchOrderStatusPrivate).mock.calls.length).toBe(calls);
  expect(screen.getByRole('textbox')).toBeVisible();
  expect(screen.queryByText('確認できました。')).not.toBeInTheDocument();
  expect(screen.queryByText(ERR.ORDER_STATUS_LOCKED)).not.toBeInTheDocument();
});

test('確認成功でGETし直し、20回目の不一致ではロック文へ切り替える', async () => {
  jest.mocked(submitOrderStatusLastFour).mockResolvedValueOnce(response({ ok: true, expiresAt: '2026-10-23T00:00:00Z' }));
  const { unmount } = render(element()); const input = await screen.findByRole('textbox');
  jest.mocked(fetchOrderStatusPrivate).mockResolvedValueOnce(response({ access: 'member', data: privateData, expiresAt: null }));
  fireEvent.change(input, { target: { value: '1234' } }); fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
  await screen.findByRole('heading', { name: 'お届け先' }); expect(fetchOrderStatusPrivate).toHaveBeenCalledTimes(2); unmount();
  jest.mocked(submitOrderStatusLastFour).mockResolvedValueOnce(response({ code: 'ORDER_STATUS_MISMATCH', verifiable: false, reason: 'locked' }, 400));
  render(element()); fireEvent.change(await screen.findByRole('textbox'), { target: { value: '1234' } }); fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
  await screen.findByText(ERR.ORDER_STATUS_LOCKED); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
