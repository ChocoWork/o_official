import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import DiscountMemberPicker from '@/features/discounts/components/DiscountMemberPicker';
import type { DiscountMember } from '@/lib/discounts/admin-discount-types';
import { failResponse, okResponse, unreadableResponse, wasDrained, expectNoActWarnings } from './discount-test-utils';

const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));

const HANAKO: DiscountMember = { userId: '44444444-4444-4444-8444-444444444444', name: '山田 花子', email: 'hanako@example.com' };
const TARO: DiscountMember = { userId: '55555555-5555-4555-8555-555555555555', name: null, email: 'taro@example.com' };
const searchUrls = (): string[] => mockFetch.mock.calls.map(([url]) => String(url));

/** 選んだ会員を持つ親。onChange に渡った最新の値を selectedNow() で読む */
const changes = jest.fn();
const selectedNow = (): DiscountMember[] => (changes.mock.calls.at(-1)?.[0] as DiscountMember[] | undefined) ?? [];
function Harness({ initial = [] }: { initial?: DiscountMember[] }) {
  const [selected, setSelected] = useState<DiscountMember[]>(initial);
  return <DiscountMemberPicker selected={selected} onChange={(members) => { changes(members); setSelected(members); }} />;
}

const type = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: '会員を探す' }), { target: { value } });
const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };

beforeEach(() => {
  jest.useFakeTimers();
  mockFetch.mockReset();
  changes.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expectNoActWarnings();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('会員の選択', () => {
  test('FREQ-547-AC-05: 会員の名前とメールで探して追加でき、古い検索応答と二重送信を無視する', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: [HANAKO, TARO] }));
    render(<Harness />);

    type('h');
    await advance(400);
    expect(mockFetch).not.toHaveBeenCalled();

    type('ha');
    await advance(299);
    expect(mockFetch).not.toHaveBeenCalled();
    await advance(1);
    expect(searchUrls()).toEqual(['/api/admin/discounts/members?query=ha']);

    fireEvent.click(await screen.findByRole('button', { name: '山田 花子（hanako@example.com）を追加' }));
    fireEvent.click(screen.getByRole('button', { name: 'taro@example.comを追加' }));
    expect(selectedNow().map((member) => member.userId)).toEqual([HANAKO.userId, TARO.userId]);
    expect(screen.getByText('選んだ会員 2人')).toBeInTheDocument();
    // 追加した人は候補から消え、二重には入らない
    expect(screen.queryByRole('button', { name: /を追加$/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '山田 花子（hanako@example.com）の選択を取り消す' }));
    expect(selectedNow().map((member) => member.userId)).toEqual([TARO.userId]);
  });

  test('FREQ-547-AC-05: 続けて入力すると前の検索を止め、遅れて届いた古い答えは候補を上書きしない', async () => {
    const signals: AbortSignal[] = [];
    let releaseFirst: (value: unknown) => void = () => {};
    mockFetch
      .mockImplementationOnce((_url: string, init: RequestInit) => { signals.push(init.signal as AbortSignal); return new Promise((resolve) => { releaseFirst = resolve; }); })
      .mockImplementationOnce((_url: string, init: RequestInit) => { signals.push(init.signal as AbortSignal); return Promise.resolve(okResponse({ data: [TARO] })); });
    render(<Harness />);

    type('ha');
    await advance(300);
    type('hana');
    await advance(300);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(await screen.findByRole('button', { name: 'taro@example.comを追加' })).toBeInTheDocument();

    await act(async () => { releaseFirst(okResponse({ data: [HANAKO] })); });
    expect(screen.queryByRole('button', { name: /hanako@example.com/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'taro@example.comを追加' })).toBeInTheDocument();
  });

  test('FREQ-547-AC-05: 文字を2文字未満へ戻すと検索を止めて候補を消す', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: [HANAKO] }));
    render(<Harness />);
    type('ha');
    await advance(300);
    expect(await screen.findByRole('button', { name: /を追加$/ })).toBeInTheDocument();
    type('h');
    expect(screen.queryByRole('button', { name: /を追加$/ })).not.toBeInTheDocument();
  });

  test.each([[401], [403], [429], [503], [500]])('FREQ-547-AC-05: %i の応答は本文を読み切ってから文を出し、候補を残さない', async (status) => {
    const response = failResponse(status);
    mockFetch.mockResolvedValue(response);
    render(<Harness />);
    type('ha');
    await advance(300);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(wasDrained(response)).toBe(true);
    expect(screen.queryByRole('button', { name: /を追加$/ })).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-05: 本文を読めない403は閉じてから権限の文を出す', async () => {
    const response = unreadableResponse(403);
    mockFetch.mockResolvedValue(response);
    render(<Harness />);
    type('ha');
    await advance(300);
    expect(await screen.findByText('会員を探す権限がありません。')).toBeInTheDocument();
    expect(response.body.cancel).toHaveBeenCalled();
  });

  test('FREQ-547-AC-05: 該当なしの文を出し、100人を超えては選べない', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: [] }));
    render(<Harness />);
    type('zz');
    await advance(300);
    expect(await screen.findByText('該当する会員はいません。')).toBeInTheDocument();

    const many: DiscountMember[] = Array.from({ length: 100 }, (_, i) => ({ userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: null, email: `m${i}@example.com` }));
    mockFetch.mockResolvedValue(okResponse({ data: [HANAKO] }));
    cleanup();
    render(<Harness initial={many} />);
    expect(screen.getByText('選んだ会員 100人（選べるのは100人までです）')).toBeInTheDocument();
    type('ha');
    await advance(300);
    expect(await screen.findByRole('button', { name: '山田 花子（hanako@example.com）を追加' })).toBeDisabled();
  });
});
