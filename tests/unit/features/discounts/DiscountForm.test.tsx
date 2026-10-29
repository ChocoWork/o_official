import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DiscountForm from '@/features/discounts/components/DiscountForm';
import type { AdminDiscountDetail } from '@/lib/discounts/admin-discount-types';
import { assignmentRow, definition, detailBody, failResponse, okResponse, DISCOUNT_ID, expectNoActWarnings } from './discount-test-utils';

const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));

const NEW_ID = '99999999-9999-4999-8999-999999999999';
const MEMBER = { userId: '44444444-4444-4444-8444-444444444444', name: '山田 花子', email: 'hanako@example.com' };
const ITEMS = [{ id: 1, name: 'ジャケット' }, { id: 2, name: 'パンツ' }, { id: 3, name: 'シャツ' }];
const START = '2026-11-01T10:00';
const START_ISO = '2026-11-01T01:00:00.000Z';

type Call = { url: string; method: string; body: Record<string, unknown> | null };
const writes = (): Call[] => mockFetch.mock.calls
  .map(([url, init]) => ({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : null }))
  .filter((call) => call.method !== 'GET');

let writeAnswers: Array<() => unknown>;
beforeEach(() => {
  mockFetch.mockReset();
  writeAnswers = [];
  mockFetch.mockImplementation((url: string) => {
    if (String(url) === '/api/admin/items') return Promise.resolve(okResponse({ data: ITEMS }));
    if (String(url).includes('/members')) return Promise.resolve(okResponse({ data: [MEMBER] }));
    const next = writeAnswers.length > 1 ? writeAnswers.shift() : writeAnswers[0];
    return Promise.resolve(next ? next() : okResponse({ data: { discountId: NEW_ID, version: '1', replayed: false } }, 201));
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expectNoActWarnings();
  jest.restoreAllMocks();
});

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const text = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const check = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const setSelect = (name: string, value: string) => fireEvent.change(select(name), { target: { value } });
const setText = (name: string, value: string) => fireEvent.change(text(name), { target: { value } });
const setDate = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
const submit = (label = '作成する') => fireEvent.click(screen.getByRole('button', { name: label }));

function renderCreate() {
  const onSaved = jest.fn();
  render(<DiscountForm initial={null} onSaved={onSaved} />);
  setDate('開始（日本時間）', START);
  return onSaved;
}
function renderEdit(detail: AdminDiscountDetail) {
  const onSaved = jest.fn();
  render(<DiscountForm initial={detail} onSaved={onSaved} />);
  return onSaved;
}
const fillBasic = () => {
  setText('割引の名前', ' 秋の10％引き ');
  setText('コード', 'autumn10');
};

describe('割引フォームの作成', () => {
  test('FREQ-547-AC-04: 既定は会員だけ・併用なし・広告なしで、5種類と効き方の欄を出す', () => {
    renderCreate();
    expect(within(select('割引の種類')).getAllByRole('option').map((o) => o.textContent)).toEqual(['注文の％引き', '注文の円引き', '商品の割引', 'リピート割引', 'セット割引']);
    expect(select('効き方').value).toBe('code');
    expect(select('使える人').value).toBe('anyone');
    expect(check('ログインしていない人も使える').checked).toBe(false);
    expect(check('商品の割引と重ねる').checked).toBe(false);
    expect(check('注文の割引と重ねる').checked).toBe(false);
    expect(check('初回の注文だけ').checked).toBe(false);
    expect(check('1人1回まで').checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: '商品の頁で前もって知らせる' })).not.toBeInTheDocument();
    expect(screen.queryByText(/組数/)).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-04: 注文の％引きは必須欄を検査し、窓口の入力の形で作成する', async () => {
    const onSaved = renderCreate();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(text('割引の名前')).toHaveAttribute('aria-invalid', 'true');
    expect(text('割引の名前')).toHaveAccessibleDescription('割引の名前を入力してください。');
    expect(text('コード')).toHaveAccessibleDescription(expect.stringContaining('コードは英数字とハイフンの1〜64字で入力してください。'));
    await waitFor(() => expect(text('割引の名前')).toHaveFocus());
    expect(writes()).toHaveLength(0);

    fillBasic();
    setText('割引率（％）', '100');
    submit();
    expect(await screen.findByText('割引率は1〜99の整数で入力してください。')).toBeInTheDocument();
    setText('割引率（％）', '10');
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_ID));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ url: '/api/admin/discounts', method: 'POST' });
    expect(writes()[0].body).toEqual({
      requestKey: expect.any(String),
      input: {
        name: '秋の10％引き', kind: 'order_percent', method: 'code', value: { type: 'percent', value: 10 }, targetMode: 'all', itemIds: [],
        minimum: { type: 'none', value: 0 }, audience: 'anyone', allowGuests: false, firstOrderOnly: false, usageLimit: null,
        oncePerCustomer: false, startsAt: START_ISO, endsAt: null, stopped: false, combinesWithProduct: false, combinesWithOrder: false,
        advertise: false, advertisingText: null, repeatPrevious: false, repeatInOrder: false, code: 'AUTUMN10', codeMode: 'shared',
      },
    });
  });

  test('FREQ-547-AC-04: 円引きは最低金額が必須で、割引額より大きくないと保存できない', async () => {
    renderCreate();
    fillBasic();
    setSelect('割引の種類', 'order_amount');
    expect(select('最低条件').value).toBe('amount');
    expect(within(select('最低条件')).getByRole('option', { name: '最低条件なし' })).toBeDisabled();
    setText('割引額（円）', '1000');
    setText('最低金額（円）', '1000');
    submit();
    expect(await screen.findByText('最低金額は割引額より大きくしてください。')).toBeInTheDocument();
    setText('最低金額（円）', '1001');
    submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.input).toMatchObject({ kind: 'order_amount', value: { type: 'amount', value: 1000 }, minimum: { type: 'amount', value: 1001 } });
  });

  test('FREQ-547-AC-04: 商品の割引は率と円・全部と除く服を選べ、円にすると最低金額が必要になる', async () => {
    renderCreate();
    fillBasic();
    setSelect('割引の種類', 'product');
    setSelect('割引の方法', 'amount');
    setText('割引額（円）', '500');
    submit();
    expect(await screen.findByText('最低金額は1円以上の整数で入力してください。')).toBeInTheDocument();
    setText('最低金額（円）', '3000');
    setSelect('対象の服', 'exclude');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'パンツ' }));
    submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.input).toMatchObject({
      kind: 'product', value: { type: 'amount', value: 500 }, targetMode: 'exclude', itemIds: [2], minimum: { type: 'amount', value: 3000 },
    });
  });

  test('FREQ-547-AC-04: セット割引は既定が自動で、2〜10点の服が要り、組数を選ぶ欄は無い', async () => {
    renderCreate();
    fillBasic();
    setSelect('割引の種類', 'set');
    expect(select('効き方').value).toBe('automatic');
    expect(screen.queryByRole('textbox', { name: 'コード' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '使える人' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'ジャケット' }));
    submit();
    expect(await screen.findByText('セット割引には、服を2〜10点選んでください。')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'セットにする服（2〜10点、各1着）' })).toHaveAccessibleDescription('セット割引には、服を2〜10点選んでください。');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'ジャケット' })).toHaveFocus());
    fireEvent.click(screen.getByRole('checkbox', { name: 'パンツ' }));
    submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.input).toMatchObject({
      kind: 'set', method: 'automatic', targetMode: 'include', itemIds: [1, 2], audience: 'anyone', allowGuests: true, code: null,
    });
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  test('FREQ-547-AC-04: リピート割引は対象の服とA・Bのどちらかが必須', async () => {
    renderCreate();
    fillBasic();
    setSelect('割引の種類', 'repeat');
    expect(check('B: 同じ注文の2着目から').checked).toBe(true);
    fireEvent.click(check('B: 同じ注文の2着目から'));
    submit();
    expect(await screen.findByText('対象の服を1点以上選んでください。')).toBeInTheDocument();
    expect(check('A: 前の注文で買った服も数える')).toHaveAccessibleDescription('AかBのどちらかを選んでください。');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'シャツ' }));
    fireEvent.click(check('A: 前の注文で買った服も数える'));
    submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.input).toMatchObject({ kind: 'repeat', targetMode: 'include', itemIds: [3], repeatPrevious: true, repeatInOrder: false });
  });

  test('FREQ-547-AC-04: 種類別の必須欄と１から100個の束を検査し接頭辞を有効コードに見せない', async () => {
    const onSaved = renderCreate();
    setText('割引の名前', '友人向け');
    setSelect('コードの作り方', 'batch');
    expect(screen.queryByRole('textbox', { name: 'コード' })).not.toBeInTheDocument();
    setText('コードの先頭の文字', 'friend');
    expect(screen.getByText('コードは「FRIEND-」に4〜8文字が続く形になります。先頭の文字だけでは使えません。')).toBeInTheDocument();
    expect(screen.queryByText('FRIEND', { exact: true })).not.toBeInTheDocument();

    setText('束の個数', '0');
    submit();
    expect(await screen.findByText('束の個数は1〜100で入力してください。')).toBeInTheDocument();
    setText('束の個数', '101');
    submit();
    expect(await screen.findByText('束の個数は1〜100で入力してください。')).toBeInTheDocument();
    setText('コードの先頭の文字', '-bad-');
    setText('束の個数', '100');
    submit();
    expect(await screen.findByText('コードの先頭の文字は、英数字とハイフンの1〜55字で入力してください。')).toBeInTheDocument();
    expect(writes()).toHaveLength(0);

    setText('コードの先頭の文字', 'friend');
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_ID));
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body?.input).toMatchObject({ method: 'code', codeMode: 'batch', code: null, initialBatch: { prefix: 'FRIEND', userIds: [], count: 100 } });
  });

  test('FREQ-547-AC-04: 会員を選ぶと束の個数は選んだ人数になり、その会員へ割り当てる', async () => {
    const onSaved = renderCreate();
    setText('割引の名前', '友人向け');
    setSelect('コードの作り方', 'batch');
    setText('コードの先頭の文字', 'friend');
    setText('会員を探す', 'ha');
    fireEvent.click(await screen.findByRole('button', { name: '山田 花子（hanako@example.com）を追加' }, { timeout: 2000 }));
    expect(text('束の個数')).toBeDisabled();
    expect(text('束の個数').value).toBe('1');
    setSelect('使える人', 'assigned');
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes()[0].body?.input).toMatchObject({ audience: 'assigned', initialBatch: { prefix: 'FRIEND', userIds: [MEMBER.userId], count: 1 } });
  });

  test.each(['assigned', 'anyone'])('FREQ-547-AC-04: 束の使える人%sと会員の組が違えばPOST前に止める', async (audience) => {
    renderCreate();
    setText('割引の名前', '友人向け');
    setSelect('コードの作り方', 'batch');
    setText('コードの先頭の文字', 'friend');
    setSelect('使える人', audience);
    if (audience === 'anyone') {
      setText('会員を探す', 'ha');
      fireEvent.click(await screen.findByRole('button', { name: '山田 花子（hanako@example.com）を追加' }));
    }
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(select('使える人')).toHaveAttribute('aria-invalid', 'true');
    expect(writes()).toHaveLength(0);
  });

  test('FREQ-547-AC-04: 束は割引と同じPOSTで作り、失敗後の再送も同じ番号で全体を再試行する', async () => {
    writeAnswers = [() => failResponse(503, { code: 'GROUP_H_CODE_GENERATION_FAILED', error: 'コードを作れませんでした。もう一度お試しください。' }),
      () => okResponse({ data: { discountId: NEW_ID, version: '1', replayed: false } }, 201)];
    const onSaved = renderCreate();
    setText('割引の名前', '友人向け');
    setSelect('コードの作り方', 'batch');
    setText('コードの先頭の文字', 'friend');
    setText('束の個数', '2');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('コードを作れませんでした。もう一度お試しください。');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '作った割引を開く' })).not.toBeInTheDocument();
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_ID));
    expect(writes().map((call) => call.url)).toEqual(['/api/admin/discounts', '/api/admin/discounts']);
    expect(writes()[1].body).toEqual(writes()[0].body);
  });

  test('FREQ-547-AC-04: 割り当てた人だけではログインしていない人の欄を選べず、falseに固定する', async () => {
    renderCreate();
    fillBasic();
    fireEvent.click(check('ログインしていない人も使える'));
    expect(check('ログインしていない人も使える').checked).toBe(true);
    setSelect('使える人', 'assigned');
    expect(check('ログインしていない人も使える')).toBeDisabled();
    expect(check('ログインしていない人も使える').checked).toBe(false);
    submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.input).toMatchObject({ audience: 'assigned', allowGuests: false });
  });

  test('FREQ-547-AC-04: 自動では人の割当欄と使える人を出さず、重ねる上限の説明を重ねる欄に結ぶ', () => {
    renderCreate();
    setSelect('効き方', 'automatic');
    expect(screen.queryByRole('combobox', { name: '使える人' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'コードの作り方' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '会員を探す' })).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'ほかの割引と重ねる' });
    expect(group).toHaveAccessibleDescription('重ねられる自動の割引は、商品の割引と注文の割引でそれぞれ6件までです。');
    expect(check('商品の頁で前もって知らせる')).toBeInTheDocument();
    fireEvent.click(check('商品の頁で前もって知らせる'));
    expect(text('案内文')).toBeInTheDocument();
  });

  test('FREQ-547-AC-04: 自動で広告を入れるなら案内文が必須で、窓口には案内文つきで送る', async () => {
    renderCreate();
    setText('割引の名前', '2着目から');
    setSelect('効き方', 'automatic');
    fireEvent.click(check('商品の頁で前もって知らせる'));
    submit();
    expect(await screen.findByText('案内文を入力してください。')).toBeInTheDocument();
    setText('案内文', ' 2着目から15%引き ');
    submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.input).toMatchObject({ method: 'automatic', advertise: true, advertisingText: '2着目から15%引き', code: null, audience: 'anyone' });
  });

  test('FREQ-547-AC-04: 終了が開始以前なら保存せず、日本時間の欄に誤りを結ぶ', async () => {
    renderCreate();
    fillBasic();
    setDate('終了（日本時間）', '2026-11-01T10:00');
    submit();
    expect(await screen.findByText('終了は開始より後にしてください。')).toBeInTheDocument();
    setDate('終了（日本時間）', '2026-12-01T10:00');
    setText('全体の回数の上限', '0');
    submit();
    expect(await screen.findByText('回数の上限は1以上の整数で入力してください。')).toBeInTheDocument();
    setText('全体の回数の上限', '50');
    submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.input).toMatchObject({ endsAt: '2026-12-01T01:00:00.000Z', usageLimit: 50 });
  });

  test.each([
    ['GROUP_H_STACKABLE_AUTOMATIC_LIMIT', '重ねられる自動の割引は、商品の割引と注文の割引でそれぞれ6件までです。', 'ほかの割引と重ねる'],
    ['GROUP_H_STACKABLE_SET_ITEM_CONFLICT', '同じ服を含むセット割引は、同じ期間に重ねる設定にできません。', 'ほかの割引と重ねる'],
  ])('FREQ-547-AC-04: 窓口の %s の拒否文を重ねる欄に結ぶ', async (code, message) => {
    writeAnswers = [() => failResponse(409, { code, error: message })];
    renderCreate();
    setText('割引の名前', '重ねる');
    setSelect('効き方', 'automatic');
    fireEvent.click(check('商品の割引と重ねる'));
    submit();
    expect(await screen.findByText('保存できませんでした。')).toBeInTheDocument();
    expect(check('商品の割引と重ねる')).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(check('商品の割引と重ねる')).toHaveAttribute('aria-invalid', 'true');
  });

  test('FREQ-547-AC-04: 共有コードの重複はコードの欄に、自動25件は効き方の欄に結ぶ', async () => {
    writeAnswers = [
      () => failResponse(409, { code: 'GROUP_H_CODE_CONFLICT', error: 'このコードは既に使われています。' }),
      () => failResponse(409, { code: 'GROUP_H_AUTOMATIC_LIMIT', error: '同時に有効にできる自動の割引は25件までです。' }),
    ];
    renderCreate();
    fillBasic();
    submit();
    expect(await screen.findByText('このコードは既に使われています。')).toBeInTheDocument();
    expect(text('コード')).toHaveAttribute('aria-invalid', 'true');
    setText('コード', 'another');
    submit();
    expect(await screen.findByText('同時に有効にできる自動の割引は25件までです。')).toBeInTheDocument();
    expect(select('効き方')).toHaveAttribute('aria-invalid', 'true');
    expect(select('効き方')).toHaveAccessibleDescription(expect.stringContaining('同時に有効にできる自動の割引は25件までです。'));
  });

  test.each([[429], [503], [401], [403], [500]])('FREQ-547-AC-04: 保存の%iは本文を読み切って決まった文を出し、二重に送らず同じ要求番号で再試行する', async (status) => {
    const response = failResponse(status);
    writeAnswers = [() => response, () => okResponse({ data: { discountId: NEW_ID, version: '1', replayed: false } }, 201)];
    const onSaved = renderCreate();
    fillBasic();
    submit();
    submit();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(response.arrayBuffer).toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NEW_ID));
    expect(writes()[1].body?.requestKey).toBe(writes()[0].body?.requestKey);
  });

  test('FREQ-547-AC-04: 入力を変えて再送するときは新しい要求番号を使う', async () => {
    writeAnswers = [() => failResponse(500)];
    renderCreate();
    fillBasic();
    submit();
    await screen.findByRole('alert');
    setText('コード', 'changed');
    submit();
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body?.requestKey).not.toBe(writes()[0].body?.requestKey);
  });
});

describe('割引フォームの編集', () => {
  test('FREQ-547-AC-02: 共有コードの現在値を出し、秒未満とitemIdsの順序を保存で変えない', async () => {
    const current = detailBody({ discount: definition({ kind: 'repeat', targetMode: 'include', itemIds: [3, 1], repeatInOrder: true,
      startsAt: '2026-10-01T00:00:45.123456+00:00', endsAt: '2027-10-01T00:00:45.654321+00:00' }) }).data;
    renderEdit(current);
    expect(text('コード')).toHaveValue('FRIEND');
    setText('割引の名前', '変更');
    submit('保存する');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.patch).toEqual({ name: '変更' });
  });

  test('FREQ-547-AC-02: 同じ分の中の開始と終了も元の瞬間で検査し、名前だけを送る', async () => {
    renderEdit(detailBody({ discount: definition({ startsAt: '2026-10-01T00:00:10+00:00', endsAt: '2026-10-01T00:00:45+00:00' }) }).data);
    setText('割引の名前', '変更');
    submit('保存する');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.patch).toEqual({ name: '変更' });
  });

  const used = (): AdminDiscountDetail => detailBody({ used: true, discount: definition({ name: '秋', usageLimit: 100 }) }).data;

  test('FREQ-547-AC-02: 使用後フォームは許可した欄だけ編集でき、複製から新しい割引へ進める', () => {
    renderEdit(used());
    expect(screen.getByText('使用後に値や対象を変える場合は、複製して新しく作ってください。')).toBeInTheDocument();
    for (const name of ['割引の名前', '全体の回数の上限']) expect(text(name)).toBeEnabled();
    expect(screen.getByLabelText('開始（日本時間）')).toBeEnabled();
    expect(screen.getByLabelText('終了（日本時間）')).toBeEnabled();
    for (const name of ['割引の種類', '効き方', '使える人', '最低条件']) expect(select(name)).toBeDisabled();
    expect(text('割引率（％）')).toBeDisabled();
    for (const name of ['初回の注文だけ', '1人1回まで', '商品の割引と重ねる', '注文の割引と重ねる', 'ログインしていない人も使える']) expect(check(name)).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存する' })).toBeEnabled();
  });

  test('FREQ-547-AC-02: 使用後の自動の割引は前もって知らせると案内文を編集できる', () => {
    renderEdit(detailBody({ used: true, discount: definition({ method: 'automatic', audience: 'anyone', allowGuests: true, advertise: true, advertisingText: '案内' }) }).data);
    expect(check('商品の頁で前もって知らせる')).toBeEnabled();
    expect(text('案内文')).toBeEnabled();
  });

  test('FREQ-547-AC-02: 保存は変えた欄だけを版つきで送り、成功したら通知する', async () => {
    writeAnswers = [() => okResponse({ data: { discountId: DISCOUNT_ID, version: '4', replayed: false } })];
    const onSaved = renderEdit(used());
    setText('割引の名前', ' 冬 ');
    setText('全体の回数の上限', '');
    submit('保存する');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(DISCOUNT_ID));
    expect(writes()[0]).toMatchObject({ url: `/api/admin/discounts/${DISCOUNT_ID}`, method: 'PATCH' });
    expect(writes()[0].body).toEqual({ patch: { name: '冬', usageLimit: null }, expectedVersion: '3', requestKey: expect.any(String) });
  });

  test('FREQ-547-AC-02: 何も変えていなければ送らず、使用済みの固定項目の窓口拒否は全体の文にする', async () => {
    renderEdit(used());
    submit('保存する');
    expect(await screen.findByRole('alert')).toHaveTextContent('変更はありません。');
    expect(writes()).toHaveLength(0);
    writeAnswers = [() => failResponse(409, { code: 'GROUP_H_USED_FIELDS_LOCKED', error: '使用後はこの項目を変更できません。複製して新しく作ってください。' })];
    setText('割引の名前', '変更');
    submit('保存する');
    expect(await screen.findByText('使用後はこの項目を変更できません。複製して新しく作ってください。')).toBeInTheDocument();
  });

  test('FREQ-547-AC-02: 未使用の編集は値と期間を変えられ、円の条件を満たさないと保存できない', async () => {
    renderEdit(detailBody({ discount: definition({ kind: 'order_amount', value: { type: 'amount', value: 500 }, minimum: { type: 'amount', value: 1000 } }) }).data);
    expect(text('割引額（円）')).toBeEnabled();
    setText('割引額（円）', '1500');
    submit('保存する');
    expect(await screen.findByText('最低金額は割引額より大きくしてください。')).toBeInTheDocument();
    setText('最低金額（円）', '2000');
    submit('保存する');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body?.patch).toEqual({ value: { type: 'amount', value: 1500 }, minimum: { type: 'amount', value: 2000 } });
  });

  test('FREQ-547-AC-02: 複製された共有コードの割引は新しいコードを設定できる', async () => {
    // 複製はコードを写さないので codes は空
    const onSaved = renderEdit(detailBody({ discount: definition({ stopped: true }), codes: [], assignments: [] }).data);
    setText('コード', 'new-code');
    submit('保存する');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes()[0].body?.patch).toEqual({ code: 'NEW-CODE' });
  });

  test('FREQ-547-AC-02: 使い捨てコードの束の割引にはコード欄を出さない', () => {
    renderEdit(detailBody({ discount: definition({ audience: 'assigned' }), codes: [{ codeId: CODE_ID_ROW, code: 'BATCH-ABCD', singleUse: true, audience: 'assigned', allowGuests: false, assignedUserId: MEMBER.userId }], assignments: [] }).data);
    expect(screen.queryByRole('textbox', { name: 'コード' })).not.toBeInTheDocument();
  });
});

const CODE_ID_ROW = '22222222-2222-4222-8222-222222222222';
