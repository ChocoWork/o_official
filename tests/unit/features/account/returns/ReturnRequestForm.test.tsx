import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockSubmit = jest.fn();
jest.mock('@/features/account/returns/customer-return-client', () => ({
  submitCustomerReturnRequest: (...args: unknown[]) => mockSubmit(...args),
}));
const mockCheck = jest.fn();
const mockResize = jest.fn();
const mockUpload = jest.fn();
// 定数（受け付ける種類・画面の文）は Task 5 の物のまま使い、ファイルを確かめる・縮める・送る3つの関数だけを差し替える
jest.mock('@/lib/orders/returns/return-photo-client', () => ({
  ...jest.requireActual<typeof import('@/lib/orders/returns/return-photo-client')>('@/lib/orders/returns/return-photo-client'),
  checkReturnPhotoFile: (...args: unknown[]) => mockCheck(...args),
  resizeReturnPhoto: (...args: unknown[]) => mockResize(...args),
  uploadReturnPhoto: (...args: unknown[]) => mockUpload(...args),
}));
jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));

import { ReturnRequestForm } from '@/features/account/returns/ReturnRequestForm';
import type { SubmitBody } from '@/features/account/returns/return-request-model';
import { BLOUSE, ORDER_ID, SHIPMENT_1, acceptedBody, materials, type Materials } from './return-request-fixtures';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIRST = '1回目の発送（10月10日発送）';
const SECOND = '2回目の発送（10月2日発送）';
const NOTE_ERROR = '詳しい内容を入れてください（300字まで）。';
const PHOTO_ERROR = '写真を1枚以上選んでください。';
const PHOTO_INVALID = '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。';

const renderForm = (overrides: Partial<Materials> = {}) => render(<ReturnRequestForm materials={materials(overrides)} />);

const first = () => screen.getByRole('region', { name: FIRST });
const second = () => screen.getByRole('region', { name: SECOND });
const lineIn = (region: HTMLElement, name: string) => within(region).getByRole('group', { name });
const blouse = () => lineIn(first(), 'シルクブラウス（白 / M）');
const pants = () => lineIn(first(), 'ウールパンツ（2）');
const scarf = () => lineIn(first(), 'シルクスカーフ（黒）');
const belt = () => lineIn(first(), 'レザーベルト（茶）');
const exchangeLine = () => lineIn(first(), 'シルクブラウス（白 / L）');

const select = (scope: HTMLElement, name: string) => within(scope).getByRole('combobox', { name }) as HTMLSelectElement;
const optionTexts = (element: HTMLElement) => within(element).getAllByRole('option').map((option) => option.textContent);
const checkButton = () => screen.getByRole('button', { name: '内容を確かめる' });
const buttonTexts = () => screen.getAllByRole('button').map((button) => button.textContent);

/** 「この商品を申し込む」にチェックを入れる */
const choose = (scope: HTMLElement) => fireEvent.click(within(scope).getByRole('checkbox', { name: 'この商品を申し込む' }));
const pick = (scope: HTMLElement, label: string, value: string) => fireEvent.change(select(scope, label), { target: { value } });
const writeNote = (scope: HTMLElement, label: string, text: string) =>
  fireEvent.change(within(scope).getByRole('textbox', { name: label }), { target: { value: text } });
const photoGroup = (scope: HTMLElement, label = '写真（必須・5枚まで）') => within(scope).getByRole('group', { name: label });
const choosePhoto = (scope: HTMLElement, name = 'a.jpg') =>
  fireEvent.change(within(photoGroup(scope)).getByTestId('return-photo-input'), {
    target: { files: [new File(['x'], name, { type: 'image/jpeg' })] },
  });
/** n 回目（0 始まり）の呼び出しが窓口へ渡した中身 */
const sentBody = (call: number) => mockSubmit.mock.calls[call][1] as SubmitBody;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** パンツ1点を「サイズが小さい」で返金にして、確かめる段へ進める */
function goToConfirm(overrides: Partial<Materials> = {}) {
  renderForm(overrides);
  choose(pants());
  pick(pants(), '理由', 'size_too_small');
  fireEvent.click(checkButton());
}

beforeEach(() => {
  mockSubmit.mockReset();
  mockCheck.mockReset().mockReturnValue('ok');
  mockResize.mockReset().mockResolvedValue(new Blob(['resized'], { type: 'image/jpeg' }));
  mockUpload.mockReset().mockResolvedValue({ kind: 'ok', uploadId: 'up-1' });
});

describe('ReturnRequestForm の見た目', () => {
  it('ご注文番号と3つの手順を出し、今の手順に aria-current を付ける。発送ごとに見出しと受付の期限を出す', () => {
    renderForm();

    expect(screen.getByText('ご注文番号: ORD-A1B2C3D4')).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'お申し込みの手順' })).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual(['1. 商品を選ぶ', '2. 内容を確かめる', '3. お申し込みの受付']);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).not.toHaveAttribute('aria-current');
    expect(steps[2]).not.toHaveAttribute('aria-current');
    // 発送日は日本時間の日付で数える（2026-10-01T16:00Z は 10月2日）
    expect(within(first()).getByRole('heading', { name: FIRST })).toBeInTheDocument();
    expect(within(first()).getByText('返品・交換の受付：10月20日まで')).toBeInTheDocument();
    expect(within(second()).getByRole('heading', { name: SECOND })).toBeInTheDocument();
    expect(within(second()).getByText('返品・交換の受付：10月11日まで')).toBeInTheDocument();
  });

  it('受付の期限が無い発送は「期限なし」と出す', () => {
    renderForm({ shipments: [{ ...SHIPMENT_1, deadlineDate: null }] });

    expect(within(first()).getByText('返品・交換の受付：期限なし')).toBeInTheDocument();
  });

  it('注意書きは設定の文をそのまま（改行も）出し、空・空白だけなら出さない', () => {
    const { unmount } = renderForm({ noticeText: '返品は未使用の物に限ります。\n送料は理由によって変わります。' });

    const notice = screen.getByTestId('return-request-notice');
    expect(notice).toHaveClass('whitespace-pre-wrap');
    expect(notice.textContent).toBe('返品は未使用の物に限ります。\n送料は理由によって変わります。');
    unmount();

    renderForm({ noticeText: '  \n ' });
    expect(screen.queryByTestId('return-request-notice')).not.toBeInTheDocument();
  });

  it('選べる品にはチェックを出し、選べない4つの状態の品は、その言葉だけを出す（チェックは出さない）', () => {
    renderForm();

    ['シルクブラウス（白 / M）', 'ウールパンツ（2）', 'シルクスカーフ（黒）', 'レザーベルト（茶）', 'シルクブラウス（白 / L）'].forEach((name) => {
      expect(within(lineIn(first(), name)).getByRole('checkbox', { name: 'この商品を申し込む' })).toBeEnabled();
    });
    const states: Array<[string, string]> = [
      ['ウールコート（黒 / L）', '受付の期限を過ぎました'],
      ['リネンシャツ（白 / S）', 'お申し込み済み'],
      // 色もサイズも無い品は名前だけ
      ['プリーツスカート', 'お返しした商品のため、お申し込みいただけません'],
      ['ウールハット（灰 / F）', 'お申し込みいただける数がありません'],
    ];
    states.forEach(([name, text]) => {
      expect(within(lineIn(second(), name)).getByText(text)).toBeInTheDocument();
    });
    expect(within(second()).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('返品不可の品には注意の文を出し、交換の品の行には「交換の品」の印を付ける。ふつうの品には出さない', () => {
    renderForm();
    const NOTICE = 'この商品は返品不可の商品です。初期不良・誤送の時だけお申し込みいただけます。';

    expect(within(scarf()).getByText(NOTICE)).toBeInTheDocument();
    expect(within(blouse()).queryByText(NOTICE)).not.toBeInTheDocument();
    expect(within(exchangeLine()).getByText('交換の品')).toBeInTheDocument();
    expect(within(blouse()).queryByText('交換の品')).not.toBeInTheDocument();
  });

  it('長い品の名前・注意書きでも横にはみ出さないよう、折り返す指定を付ける（390px 幅のページスクロールは E2E が確かめる）', () => {
    const longName = 'とても長い名前のシルクブラウス'.repeat(4);
    renderForm({
      noticeText: 'ながいちゅういがき'.repeat(10),
      shipments: [{ ...SHIPMENT_1, lines: [{ ...BLOUSE, itemName: longName }] }],
    });

    const label = `${longName}（白 / M）`;
    expect(within(screen.getByRole('group', { name: label })).getByText(label)).toHaveClass('min-w-0', 'break-words');
    expect(screen.getByTestId('return-request-notice')).toHaveClass('break-words');
  });

  it('最初は何も選んでいないので、入力欄は出さない。手順1の下に「注文の画面に戻る」と「内容を確かめる」を出す', () => {
    renderForm();

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '注文の画面に戻る' })).toHaveAttribute('href', `/account/orders/${ORDER_ID}`);
    expect(checkButton()).toBeEnabled();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });
});

describe('ReturnRequestForm の品ごとの入力', () => {
  it('チェックを入れると「数」と「理由」だけを出す。数は選べる数までで最初は1、理由は未選択', () => {
    renderForm();

    choose(blouse());

    expect(optionTexts(select(blouse(), '数'))).toEqual(['1', '2']);
    expect(select(blouse(), '数')).toHaveValue('1');
    expect(select(blouse(), '理由')).toHaveValue('');
    expect(optionTexts(select(blouse(), '理由'))[0]).toBe('選んでください');
    expect(within(blouse()).queryByLabelText(/詳しい内容/)).not.toBeInTheDocument();
    expect(within(blouse()).queryByRole('combobox', { name: 'ご希望' })).not.toBeInTheDocument();
    // ほかの品には出ない。選べる数が1の品は選びが1つだけ
    expect(within(pants()).queryByRole('combobox', { name: '数' })).not.toBeInTheDocument();
    choose(pants());
    expect(optionTexts(select(pants(), '数'))).toEqual(['1']);
  });

  it('チェックを外すと入力欄を隠し、入れ直すと前の入力が戻る', () => {
    renderForm();
    choose(pants());
    pick(pants(), '理由', 'size_too_small');

    choose(pants());
    expect(within(pants()).queryByRole('combobox', { name: '理由' })).not.toBeInTheDocument();

    choose(pants());
    expect(select(pants(), '理由')).toHaveValue('size_too_small');
  });

  it('理由は、窓口が出す9つを窓口の並びで選べる', () => {
    renderForm();
    choose(blouse());

    expect(optionTexts(select(blouse(), '理由'))).toEqual([
      '選んでください',
      '破損・不良',
      '注文と違う品が届いた',
      'サイズが小さい',
      'サイズが大きい',
      '色がイメージと違った',
      'デザインが好みでない',
      '説明と違った',
      '不要になった',
      'その他',
    ]);
  });

  it('返品不可の品は、理由が「破損・不良」「注文と違う品が届いた」の2つだけ', () => {
    renderForm();
    choose(scarf());

    expect(optionTexts(select(scarf(), '理由'))).toEqual(['選んでください', '破損・不良', '注文と違う品が届いた']);
  });

  it('交換にできる色・サイズが無い品では、ご希望が交換だけの理由（サイズが大きい）を選べない', () => {
    renderForm();
    choose(belt());

    const reasons = optionTexts(select(belt(), '理由'));
    expect(reasons).toHaveLength(9);
    expect(reasons).not.toContain('サイズが大きい');
  });

  it('選べる理由が1つも無い品（窓口が理由を出していない）は、チェックを入れられない', () => {
    renderForm({ reasons: [] });

    expect(within(blouse()).getByRole('checkbox', { name: 'この商品を申し込む' })).toBeDisabled();
  });

  it('理由を選ぶと、詳しい内容を出す。「破損・不良」「その他」は必須、ほかは任意。300字までの欄', () => {
    renderForm();
    choose(blouse());

    pick(blouse(), '理由', 'defective');
    const required = within(blouse()).getByRole('textbox', { name: '詳しい内容（必須・300字まで）' });
    expect(required).toHaveAttribute('maxlength', '300');
    expect(required).toHaveValue('');

    pick(blouse(), '理由', 'size_too_small');
    expect(within(blouse()).getByRole('textbox', { name: '詳しい内容（任意・300字まで）' })).toHaveAttribute('maxlength', '300');

    pick(blouse(), '理由', 'other');
    expect(within(blouse()).getByRole('textbox', { name: '詳しい内容（必須・300字まで）' })).toBeInTheDocument();
  });

  it('写真は理由の設定で出し分ける: 必須・任意は写真の欄（案内の文つき）、なしは出さない', () => {
    renderForm();
    choose(blouse());

    pick(blouse(), '理由', 'defective');
    expect(within(photoGroup(blouse())).getByText('破損している所が分かる写真を撮ってください。')).toBeInTheDocument();
    expect(within(photoGroup(blouse())).getByRole('button', { name: '写真を選ぶ' })).toBeEnabled();

    pick(blouse(), '理由', 'wrong_item');
    expect(photoGroup(blouse(), '写真（任意・5枚まで）')).toBeInTheDocument();
    expect(within(blouse()).queryByRole('group', { name: '写真（必須・5枚まで）' })).not.toBeInTheDocument();

    pick(blouse(), '理由', 'size_too_small');
    expect(within(blouse()).queryByRole('group', { name: /写真/ })).not.toBeInTheDocument();
  });

  it('ご希望は理由の設定で出し分ける: 返金と交換・交換だけ・返金だけ（1つだけの時は変えられない）', () => {
    renderForm();
    choose(blouse());

    pick(blouse(), '理由', 'defective');
    expect(optionTexts(select(blouse(), 'ご希望'))).toEqual(['返金', '交換']);
    expect(select(blouse(), 'ご希望')).toHaveValue('refund');
    expect(select(blouse(), 'ご希望')).toBeEnabled();

    pick(blouse(), '理由', 'size_too_large');
    expect(optionTexts(select(blouse(), 'ご希望'))).toEqual(['交換']);
    expect(select(blouse(), 'ご希望')).toHaveValue('exchange');
    expect(select(blouse(), 'ご希望')).toBeDisabled();
    // 交換だけの理由では、交換の色・サイズも出る
    expect(select(blouse(), '交換する色・サイズ')).toBeInTheDocument();

    pick(blouse(), '理由', 'color');
    expect(optionTexts(select(blouse(), 'ご希望'))).toEqual(['返金']);
    expect(select(blouse(), 'ご希望')).toHaveValue('refund');
    expect(select(blouse(), 'ご希望')).toBeDisabled();
    expect(within(blouse()).queryByRole('combobox', { name: '交換する色・サイズ' })).not.toBeInTheDocument();
  });

  it('交換の色・サイズは同じ商品の物から選ぶ。在庫が足りない物は、理由が「作って送る」ならその旨を添えて選べ、断る理由なら選べない旨を添えて外す', () => {
    renderForm();
    choose(blouse());
    pick(blouse(), '理由', 'defective');
    pick(blouse(), 'ご希望', 'exchange');

    // 在庫の無い交換が「作って送る」の理由: 白 / L（在庫0）も選べる
    expect(optionTexts(select(blouse(), '交換する色・サイズ'))).toEqual(['選んでください', '白 / M', '白 / L', '青 / M']);
    expect(select(blouse(), '交換する色・サイズ')).toHaveValue('');
    expect(within(blouse()).getByText('白 / L: お作りしてお送りします（お届けの目安 14日）')).toBeInTheDocument();
    expect(within(blouse()).queryByText(/青 \/ M:/)).not.toBeInTheDocument();

    // 在庫の無い交換が「断る」の理由: 白 / L は選べない
    pick(blouse(), '理由', 'size_too_small');
    expect(optionTexts(select(blouse(), '交換する色・サイズ'))).toEqual(['選んでください', '白 / M', '青 / M']);
    expect(within(blouse()).getByText('白 / L: 在庫がないため選べません')).toBeInTheDocument();
  });

  it('数を増やして在庫が足りなくなった色・サイズは、選べない物になり、選んでいたら未選択に戻る', () => {
    renderForm();
    choose(blouse());
    pick(blouse(), '理由', 'size_too_small');
    pick(blouse(), 'ご希望', 'exchange');
    pick(blouse(), '交換する色・サイズ', '104');
    expect(select(blouse(), '交換する色・サイズ')).toHaveValue('104');

    pick(blouse(), '数', '2');

    expect(select(blouse(), '交換する色・サイズ')).toHaveValue('');
    expect(optionTexts(select(blouse(), '交換する色・サイズ'))).toEqual(['選んでください', '白 / M']);
    expect(within(blouse()).getByText('青 / M: 在庫がないため選べません')).toBeInTheDocument();
  });

  it('作って送る色・サイズのお届けの目安が無い（または0日）時は、日数を添えない', () => {
    renderForm({
      exchangeOptions: [
        {
          itemId: 11,
          variants: [
            { variantId: 102, color: '白', size: 'L', stockQuantity: 0, madeToOrderLeadDays: null },
            { variantId: 104, color: '青', size: 'M', stockQuantity: 0, madeToOrderLeadDays: 0 },
          ],
        },
      ],
    });
    choose(blouse());
    pick(blouse(), '理由', 'defective');
    pick(blouse(), 'ご希望', 'exchange');

    expect(within(blouse()).getByText('白 / L: お作りしてお送りします')).toBeInTheDocument();
    expect(within(blouse()).getByText('青 / M: お作りしてお送りします')).toBeInTheDocument();
  });

  it('ご希望を返金に戻すと、交換の色・サイズの欄を隠す', () => {
    renderForm();
    choose(blouse());
    pick(blouse(), '理由', 'defective');
    pick(blouse(), 'ご希望', 'exchange');
    expect(select(blouse(), '交換する色・サイズ')).toBeInTheDocument();

    pick(blouse(), 'ご希望', 'refund');

    expect(within(blouse()).queryByRole('combobox', { name: '交換する色・サイズ' })).not.toBeInTheDocument();
  });
});

describe('ReturnRequestForm の入力の確かめ', () => {
  it('何も選ばずに「内容を確かめる」を押すと、商品を選ぶ誤りを出して進まない', () => {
    renderForm();

    fireEvent.click(checkButton());

    expect(screen.getByRole('alert')).toHaveTextContent('申し込む商品を選んでください。');
    expect(within(screen.getByRole('list', { name: 'お申し込みの手順' })).getAllByRole('listitem')[0]).toHaveAttribute('aria-current', 'step');
    expect(first()).toBeInTheDocument();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('押すまでは誤りを出さない。理由が未選択なら、理由の誤りを出し、その欄へ移る。選べば消える', () => {
    renderForm();
    choose(pants());
    expect(within(pants()).queryByText('理由を選んでください。')).not.toBeInTheDocument();

    fireEvent.click(checkButton());

    expect(within(pants()).getByText('理由を選んでください。')).toBeInTheDocument();
    expect(select(pants(), '理由')).toHaveFocus();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();

    pick(pants(), '理由', 'size_too_small');
    expect(within(pants()).queryByText('理由を選んでください。')).not.toBeInTheDocument();
  });

  it('詳しい内容が必須の理由で空（空白だけも）なら誤りを出して、その欄へ移る。入れると消える', () => {
    renderForm();
    choose(pants());
    pick(pants(), '理由', 'other');

    fireEvent.click(checkButton());

    expect(within(pants()).getByText(NOTE_ERROR)).toBeInTheDocument();
    expect(within(pants()).getByRole('textbox', { name: '詳しい内容（必須・300字まで）' })).toHaveFocus();
    writeNote(pants(), '詳しい内容（必須・300字まで）', '   ');
    expect(within(pants()).getByText(NOTE_ERROR)).toBeInTheDocument();

    writeNote(pants(), '詳しい内容（必須・300字まで）', '色が写真と違います');
    expect(within(pants()).queryByText(NOTE_ERROR)).not.toBeInTheDocument();
  });

  it('写真が必須の理由で写真が無ければ誤りを出して、「写真を選ぶ」へ移る', () => {
    renderForm();
    choose(blouse());
    pick(blouse(), '理由', 'defective');
    writeNote(blouse(), '詳しい内容（必須・300字まで）', '縫い目がほつれています');

    fireEvent.click(checkButton());

    expect(within(photoGroup(blouse())).getByText(PHOTO_ERROR)).toBeInTheDocument();
    expect(within(photoGroup(blouse())).getByRole('button', { name: '写真を選ぶ' })).toHaveFocus();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('ご希望が交換で色・サイズが未選択なら誤りを出して、その欄へ移る。選べば消える', () => {
    renderForm();
    choose(blouse());
    pick(blouse(), '理由', 'size_too_small');
    pick(blouse(), 'ご希望', 'exchange');

    fireEvent.click(checkButton());

    expect(within(blouse()).getByText('交換する色・サイズを選んでください。')).toBeInTheDocument();
    expect(select(blouse(), '交換する色・サイズ')).toHaveFocus();
    pick(blouse(), '交換する色・サイズ', '101');
    expect(within(blouse()).queryByText('交換する色・サイズを選んでください。')).not.toBeInTheDocument();
  });

  it('誤りが複数の品にあれば、材料の並びで最初の品の最初の誤りの欄へ移る', () => {
    renderForm();
    choose(pants());
    choose(blouse());

    fireEvent.click(checkButton());

    expect(within(blouse()).getByText('理由を選んでください。')).toBeInTheDocument();
    expect(within(pants()).getByText('理由を選んでください。')).toBeInTheDocument();
    expect(select(blouse(), '理由')).toHaveFocus();
  });

  it('写真を送っている間は「内容を確かめる」を押せず、フォームの送信も受け付けない。送り終えたら押せる', async () => {
    const upload = deferred<{ kind: 'ok'; uploadId: string }>();
    mockUpload.mockReturnValueOnce(upload.promise);
    renderForm();
    choose(blouse());
    pick(blouse(), '理由', 'defective');
    writeNote(blouse(), '詳しい内容（必須・300字まで）', '縫い目がほつれています');

    choosePhoto(blouse());

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(within(blouse()).getByText('写真を送っています…')).toBeInTheDocument();
    expect(checkButton()).toBeDisabled();
    fireEvent.submit(checkButton().closest('form') as HTMLFormElement);
    expect(screen.queryByRole('heading', { name: 'お申し込みの内容' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();

    upload.resolve({ kind: 'ok', uploadId: 'up-5' });

    await waitFor(() => expect(checkButton()).toBeEnabled());
    fireEvent.click(checkButton());
    expect(screen.getByRole('heading', { name: 'お申し込みの内容' })).toBeInTheDocument();
  });
});

describe('ReturnRequestForm の確かめる段と受け付けた段', () => {
  it('入力が通ったら確かめる段へ進み、入力した中身と返送料、注意を出す。最初の段の入力欄は隠す', () => {
    goToConfirm({ noticeText: '返品は未使用の物に限ります。' });

    const steps = within(screen.getByRole('list', { name: 'お申し込みの手順' })).getAllByRole('listitem');
    expect(steps[0]).not.toHaveAttribute('aria-current');
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('heading', { name: 'お申し込みの内容' })).toHaveFocus();
    expect(screen.getByText('ウールパンツ（2） × 1')).toBeInTheDocument();
    expect(screen.getByText('理由: サイズが小さい')).toBeInTheDocument();
    expect(screen.getByText('ご希望: 返金')).toBeInTheDocument();
    expect(screen.getByText('返送料: お客様のご負担です')).toBeInTheDocument();
    expect(screen.getByText('お申し込みの後、当店で内容を確かめてから、メールでご連絡します。')).toBeInTheDocument();
    // 注意書きは手順1と2に出す
    expect(screen.getByTestId('return-request-notice')).toHaveTextContent('返品は未使用の物に限ります。');
    expect(screen.queryByRole('region', { name: FIRST })).not.toBeInTheDocument();
    expect(buttonTexts()).toEqual(['戻る', '申し込む']);
  });

  it('返送料と手数料は設定の仮の値を出す: 理由にお店の負担があれば「当店が負担」。お客様の負担でお店の送り状なら定額。手数料は関わる物だけ', () => {
    renderForm({
      fees: { customerPaidMethod: 'shop_label', shopLabelFee: 800, restockingFeePercent: 10, exchangeFee: 500, exchangeShippingFee: 1200 },
    });
    choose(pants());
    pick(pants(), '理由', 'size_too_small');
    fireEvent.click(checkButton());

    expect(screen.getByText('返送料: ￥800（ご返金から差し引きます）')).toBeInTheDocument();
    expect(screen.getByText('返品の手数料: ご返金の商品の額の 10%')).toBeInTheDocument();
    expect(screen.getByText('手数料はご返金から差し引きます。差し引けない分は、お支払いのご案内をお送りします。')).toBeInTheDocument();
    expect(screen.queryByText(/交換の手数料/)).not.toBeInTheDocument();
    expect(screen.queryByText(/交換の送料/)).not.toBeInTheDocument();
  });

  it('交換だけの申し込みでは、手数料の添え書きが「お支払いのご案内」の文になる（差し引く返金が無いため）', () => {
    renderForm({
      fees: { customerPaidMethod: 'customer_ships', shopLabelFee: 0, restockingFeePercent: 10, exchangeFee: 500, exchangeShippingFee: 0 },
    });
    choose(pants());
    // 「サイズが大きい」はご希望が交換だけの理由
    pick(pants(), '理由', 'size_too_large');
    pick(pants(), '交換する色・サイズ', '201');
    fireEvent.click(checkButton());

    expect(screen.getByText('ご希望: 交換（2）')).toBeInTheDocument();
    expect(screen.getByText('交換の手数料: ￥500')).toBeInTheDocument();
    expect(screen.queryByText(/返品の手数料/)).not.toBeInTheDocument();
    expect(screen.getByText('手数料は、お支払いのご案内をお送りします。お支払いの後に交換の品をお送りします。')).toBeInTheDocument();
    expect(screen.queryByText(/ご返金から差し引きます/)).not.toBeInTheDocument();
  });

  it('「戻る」で最初の段へ戻り、入力は残る。確かめる段に入り直すたびに、二重防止の番号は新しくなる', async () => {
    mockSubmit
      .mockResolvedValueOnce({ kind: 'refused', message: 'お申し込みいただける数を超えています。画面を開き直してください。', code: 'RETURN_QUANTITY_EXCEEDS', invalidPhotoUploadIds: [] })
      .mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    goToConfirm();
    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('お申し込みいただける数を超えています'));

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(within(first()).getByRole('heading', { name: FIRST })).toBeInTheDocument();
    expect(within(pants()).getByRole('checkbox', { name: 'この商品を申し込む' })).toBeChecked();
    expect(select(pants(), '理由')).toHaveValue('size_too_small');
    // 確かめる段に入り直した時に作った、新しい番号で送る
    fireEvent.click(checkButton());
    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    expect(sentBody(0).requestKey).toMatch(UUID_PATTERN);
    expect(sentBody(1).requestKey).toMatch(UUID_PATTERN);
    expect(sentBody(1).requestKey).not.toBe(sentBody(0).requestKey);
    expect(sentBody(1).lines).toEqual(sentBody(0).lines);
  });

  it('窓口へ、注文の番号と、入力の全部（数・理由・詳しい内容・送り終えた写真・ご希望・交換の色・サイズ）を二重防止の番号つきで送る', async () => {
    mockSubmit.mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    renderForm();
    choose(blouse());
    pick(blouse(), '数', '2');
    pick(blouse(), '理由', 'defective');
    writeNote(blouse(), '詳しい内容（必須・300字まで）', '  縫い目がほつれています  ');
    choosePhoto(blouse());
    await screen.findByRole('button', { name: 'この写真を外す' });
    pick(blouse(), 'ご希望', 'exchange');
    pick(blouse(), '交換する色・サイズ', '102');
    choose(pants());
    pick(pants(), '理由', 'size_too_small');

    fireEvent.click(checkButton());
    // 確かめる段の文
    expect(screen.getByText('シルクブラウス（白 / M） × 2')).toBeInTheDocument();
    expect(screen.getByText('理由: 破損・不良')).toBeInTheDocument();
    expect(screen.getByText('詳しい内容: 縫い目がほつれています')).toBeInTheDocument();
    expect(screen.getByText('ご希望: 交換（白 / L）')).toBeInTheDocument();
    expect(screen.getByText('写真 1枚')).toBeInTheDocument();
    expect(screen.getByText('返送料: 当店が負担します（着払いでお送りください）')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));

    expect(mockSubmit).toHaveBeenCalledWith(ORDER_ID, {
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [
        {
          fulfillmentId: 'ful-1', orderItemId: 'item-blouse', quantity: 2, reason: 'defective', customerNote: '縫い目がほつれています',
          requestedResolution: 'exchange', requestedExchangeVariantId: 102, photoUploadIds: ['up-1'],
        },
        {
          fulfillmentId: 'ful-1', orderItemId: 'item-pants', quantity: 1, reason: 'size_too_small', customerNote: null,
          requestedResolution: 'refund', requestedExchangeVariantId: null, photoUploadIds: [],
        },
      ],
    });
  });

  it('受け付けたら3段目に進み、受け付けた文と返品番号と「注文の画面に戻る」を出す。注意書きは出さない', async () => {
    mockSubmit.mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(2) });
    goToConfirm({ noticeText: '返品は未使用の物に限ります。' });

    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));

    const accepted = await screen.findByTestId('return-request-accepted');
    expect(within(accepted).getByText('お申し込みを受け付けました。内容を確かめて、メールでご連絡します。')).toBeInTheDocument();
    expect(within(accepted).getByText('返品番号: ORD-A1B2C3D4-R2')).toBeInTheDocument();
    expect(within(accepted).getByRole('link', { name: '注文の画面に戻る' })).toHaveAttribute('href', `/account/orders/${ORDER_ID}`);
    const steps = within(screen.getByRole('list', { name: 'お申し込みの手順' })).getAllByRole('listitem');
    expect(steps[2]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).not.toHaveAttribute('aria-current');
    expect(screen.queryByTestId('return-request-notice')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'お申し込みの内容' })).not.toBeInTheDocument();
  });

  it('Review Focus 1: 答えが分からない時は、手順2のまま「もう一度確かめる」だけにする（入力は止まる）', async () => {
    mockSubmit.mockResolvedValueOnce({ kind: 'unknown' });
    goToConfirm();

    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));

    expect(await screen.findByRole('button', { name: 'もう一度確かめる' })).toBeInTheDocument();
    expect(buttonTexts()).toEqual(['もう一度確かめる']);
    expect(screen.getByRole('alert')).toHaveTextContent('お申し込みの結果を確かめられませんでした。');
    expect(screen.queryByRole('region', { name: FIRST })).not.toBeInTheDocument();
    expect(screen.queryByTestId('return-request-accepted')).not.toBeInTheDocument();
  });
});

describe('ReturnRequestForm の写真が合わないと断られた時', () => {
  async function requestWithTwoPhotos() {
    mockUpload.mockReset().mockResolvedValueOnce({ kind: 'ok', uploadId: 'up-1' }).mockResolvedValueOnce({ kind: 'ok', uploadId: 'up-2' });
    renderForm();
    choose(blouse());
    pick(blouse(), '理由', 'defective');
    writeNote(blouse(), '詳しい内容（必須・300字まで）', '縫い目がほつれています');
    choosePhoto(blouse(), 'a.jpg');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'この写真を外す' })).toHaveLength(1));
    choosePhoto(blouse(), 'b.jpg');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'この写真を外す' })).toHaveLength(2));
    fireEvent.click(checkButton());
    // 窓口の答えを受けた後の state の更新（手順1へ戻る・写真を外す）が終わるまで待ってから返す
    // （act の外で更新が起きると「not wrapped in act」の警告が出て、後の試験に漏れうる）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
    });
  }

  it('合わない写真（置いてから23時間を過ぎた送り先など）だけを外して最初の段へ戻し、文を出す。残った写真で、また確かめて送れる', async () => {
    mockSubmit
      .mockResolvedValueOnce({ kind: 'refused', message: PHOTO_INVALID, code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds: ['up-2'] })
      .mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    await requestWithTwoPhotos();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(PHOTO_INVALID));
    // 押したボタンが消えるので、断りの文へフォーカスが移る
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(first()).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'この写真を外す' })).toHaveLength(1);
    expect(within(photoGroup(blouse())).queryByText(PHOTO_ERROR)).not.toBeInTheDocument();

    fireEvent.click(checkButton());
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    expect(sentBody(0).lines[0].photoUploadIds).toEqual(['up-1', 'up-2']);
    expect(sentBody(1).lines[0].photoUploadIds).toEqual(['up-1']);
    expect(sentBody(1).requestKey).not.toBe(sentBody(0).requestKey);
  });

  it('DB が写真を断って、合わない写真が分からない時（番号が空）は、写真を残して最初の段へ戻し、文を出す。同じ写真で、また確かめて送れる', async () => {
    mockSubmit
      .mockResolvedValueOnce({ kind: 'refused', message: PHOTO_INVALID, code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds: [] })
      .mockResolvedValueOnce({ kind: 'ok', body: acceptedBody(1) });
    await requestWithTwoPhotos();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(PHOTO_INVALID));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(first()).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'この写真を外す' })).toHaveLength(2);

    fireEvent.click(checkButton());
    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    expect(sentBody(1).lines[0].photoUploadIds).toEqual(['up-1', 'up-2']);
    expect(sentBody(1).requestKey).not.toBe(sentBody(0).requestKey);
  });

  it('必須の写真がすべて合わなかった時は、写真の欄に「1枚以上選んでください」を出す', async () => {
    mockSubmit.mockResolvedValueOnce({
      kind: 'refused', message: PHOTO_INVALID, code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds: ['up-1', 'up-2'],
    });
    await requestWithTwoPhotos();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(PHOTO_INVALID));
    expect(screen.queryByRole('button', { name: 'この写真を外す' })).not.toBeInTheDocument();
    expect(within(photoGroup(blouse())).getByText(PHOTO_ERROR)).toBeInTheDocument();
  });
});
