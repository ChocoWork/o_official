import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderReturnsData } from '@/components/OrderReturnsDialog';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';
import { LABEL, ORDER_ID, jsonResponse, returnDetail, returnLine } from './return-review-test-fixtures';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

/** 操作の画面が受ける props。この試験では代役にして、渡した物と呼び戻しだけを確かめる */
type MockSubProps = {
  orderId: string;
  returnId: string;
  onClose: () => void;
  onDone: (notice?: string) => void;
  onUncertain?: () => void;
};
type MockReviewProps = MockSubProps & { onApproved: (input: { notRequired: boolean }) => void };

function mockSubDialog(name: string, props: MockSubProps) {
  return (
    <div role="dialog" aria-label={`${name}の代役`} data-order-id={props.orderId} data-return-id={props.returnId}>
      <button type="button" onClick={() => props.onDone(`${name}を記録しました。`)}>{`${name}を完了`}</button>
      <button type="button" onClick={() => props.onUncertain?.()}>{`${name}の答えが分からない`}</button>
      <button type="button" onClick={props.onClose}>{`${name}を閉じる`}</button>
    </div>
  );
}

jest.mock('@/components/OrderReturnReviewDialog', () => ({
  __esModule: true,
  default: (props: MockReviewProps) => (
    <div role="dialog" aria-label="申し込みを確かめるの代役" data-order-id={props.orderId} data-return-id={props.returnId}>
      <button type="button" onClick={() => props.onApproved({ notRequired: false })}>承認した（返送あり）</button>
      <button type="button" onClick={() => props.onApproved({ notRequired: true })}>承認した（返送不要）</button>
      <button type="button" onClick={() => props.onDone('お断りしました。')}>お断りした</button>
      <button type="button" onClick={() => props.onUncertain?.()}>確かめるの答えが分からない</button>
      <button type="button" onClick={props.onClose}>確かめるを閉じる</button>
    </div>
  ),
}));
jest.mock('@/components/OrderReturnReceiveDialog', () => ({
  __esModule: true,
  default: (props: MockSubProps) => mockSubDialog('受け取り', props),
}));
jest.mock('@/components/OrderReturnRefundDialog', () => ({
  __esModule: true,
  default: (props: MockSubProps) => mockSubDialog('額を決めて返金', props),
}));
jest.mock('@/components/OrderReturnActionDialogs', () => ({
  __esModule: true,
  OrderReturnInspectDialog: (props: MockSubProps) => mockSubDialog('検品', props),
  OrderReturnCancelDialog: (props: MockSubProps) => mockSubDialog('取消', props),
  OrderReturnReopenDialog: (props: MockSubProps) => mockSubDialog('開き直し', props),
  OrderReturnFeePaymentDialog: (props: MockSubProps) => mockSubDialog('手数料', props),
  OrderReturnReleaseExchangeDialog: (props: MockSubProps) => mockSubDialog('支払いを待たずに送る', props),
}));
jest.mock('@/components/OrderReturnCreateForm', () => ({ __esModule: true, default: () => null }));

import OrderReturnsDialog from '@/components/OrderReturnsDialog';

const TITLE = '返品（ORD-A1B2C3D4）';
const SECOND_LABEL = 'ORD-A1B2C3D4-R2';
const THIRD_LABEL = 'ORD-A1B2C3D4-R3';
const REVIEW_MOCK = '申し込みを確かめるの代役';

type ListBody = { data: OrderReturnsData };

function listBody(returns: OrderReturnDetail[]): ListBody {
  return {
    data: { returns, canRefund: true, returnableUnits: 3, refundableAmount: 24000, refundableShipping: 800, inspectionEnabled: false },
  };
}

/** 返品の一覧の窓口は、呼ぶたびに今の中身を返す（読み直しが何回あっても答える） */
function serve(current: () => ListBody) {
  mockClientFetch.mockImplementation(async () => jsonResponse(current()));
}

function renderDialog(canRefund = true) {
  const props = { onClose: jest.fn(), onChanged: jest.fn() };
  const utils = render(<OrderReturnsDialog orderId={ORDER_ID} canRefund={canRefund} open {...props} />);
  return { ...utils, ...props };
}

/** 返品の欄が出るまで待つ（読み込み中の文が消える） */
async function listDialog() {
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return dialog;
}

/** 返品の欄を開く。申し込み中の返品があると、最初は確かめる画面（代役）が開くので、「閉じる」で返品の欄に戻る */
async function openList(canRefund = true) {
  const rendered = renderDialog(canRefund);
  fireEvent.click(await screen.findByRole('button', { name: '確かめるを閉じる' }));
  return { ...rendered, dialog: await listDialog() };
}

const card = (dialog: HTMLElement, label = LABEL) => within(dialog).getByRole('group', { name: label });
const buttonNames = (scope: HTMLElement) => within(scope).queryAllByRole('button').map((button) => button.textContent);

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnsDialog の申し込み中の返品', () => {
  it('「申し込みを確かめる」だけを出し、行にはご希望と写真の数を出す。解決の仮の値は出さない', async () => {
    const requested = returnDetail({
      lines: [
        returnLine({ photos: [{ id: 'photo-1', purged: false }, { id: 'photo-2', purged: false }] }),
        returnLine({
          id: 'line-pants',
          orderItemId: 'item-pants',
          itemName: 'ウールパンツ',
          color: null,
          size: '2',
          quantity: 1,
          resolution: 'exchange',
          exchange: { variantId: 202, color: null, size: '3', method: 'stock', stockQuantity: 4, madeToOrderLeadDays: null, outOfStockExchange: 'decline' },
          requestedResolution: 'exchange',
          requestedExchange: { variantId: 202, color: null, size: '3' },
        }),
      ],
    });
    serve(() => listBody([requested]));
    const { dialog } = await openList();

    const first = card(dialog);
    expect(within(first).getByText('返品の申し込み')).toBeInTheDocument();
    expect(buttonNames(first)).toEqual(['申し込みを確かめる']);
    expect(within(first).getByText('シルクブラウス（白 / M） × 2')).toBeInTheDocument();
    expect(within(first).getByText('ご希望: 返金')).toBeInTheDocument();
    expect(within(first).getByText('写真 2枚')).toBeInTheDocument();
    expect(within(first).getByText('ウールパンツ（2） × 1')).toBeInTheDocument();
    expect(within(first).getByText('ご希望: 交換（3）')).toBeInTheDocument();
    expect(within(first).queryByText(/在庫から|作って送る/)).not.toBeInTheDocument();
    expect(within(first).queryByText('返金')).not.toBeInTheDocument();
  });

  it('サポート（店長でない人）にも、「申し込みを確かめる」だけを出す', async () => {
    serve(() => listBody([returnDetail()]));
    const { dialog } = await openList(false);

    expect(buttonNames(card(dialog))).toEqual(['申し込みを確かめる']);
  });

  it('申し込み中でない返品は、段1のまま（ご希望も写真の数も出さず、解決と受け取りのボタンを出す）', async () => {
    const open = returnDetail({
      status: 'open',
      source: 'shop',
      displayStatus: 'in_progress',
      marks: ['awaiting_items'],
      lines: [returnLine({ requestedResolution: null, customerNote: null, photos: [{ id: 'photo-1', purged: false }] })],
    });
    serve(() => listBody([open]));
    renderDialog();
    const dialog = await listDialog();

    const only = card(dialog);
    expect(within(only).getByText('返金')).toBeInTheDocument();
    expect(within(only).queryByText(/ご希望/)).not.toBeInTheDocument();
    expect(within(only).queryByText(/写真/)).not.toBeInTheDocument();
    expect(buttonNames(only)).toEqual(['受け取る', '返品を取り消す']);
  });
});

describe('OrderReturnsDialog から申し込みを確かめる画面を開く', () => {
  it('最初の読み込みで申し込み中の返品があれば、返品の欄を出さずに、先頭の1件の確かめる画面を開く', async () => {
    serve(() => listBody([returnDetail({ id: 'ret-new', number: 2, label: SECOND_LABEL }), returnDetail()]));
    renderDialog();

    const review = await screen.findByRole('dialog', { name: REVIEW_MOCK });
    expect(review).toHaveAttribute('data-order-id', ORDER_ID);
    expect(review).toHaveAttribute('data-return-id', 'ret-new');
    expect(screen.queryByRole('dialog', { name: TITLE })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('申し込み中の返品が無ければ、確かめる画面は開かない', async () => {
    serve(() => listBody([returnDetail({ status: 'open', displayStatus: 'in_progress', marks: ['awaiting_items'] })]));
    renderDialog();

    await listDialog();
    expect(screen.queryByRole('dialog', { name: REVIEW_MOCK })).not.toBeInTheDocument();
  });

  it('開くのは最初の1回だけ。閉じた後に読み直しても、勝手には開かず、カードの「申し込みを確かめる」から開ける', async () => {
    let current = listBody([returnDetail()]);
    serve(() => current);
    const { dialog } = await openList();
    current = listBody([returnDetail(), returnDetail({ id: 'ret-newer', number: 3, label: THIRD_LABEL })]);

    fireEvent.click(within(card(dialog)).getByRole('button', { name: '申し込みを確かめる' }));
    const review = await screen.findByRole('dialog', { name: REVIEW_MOCK });
    expect(review).toHaveAttribute('data-return-id', 'ret-0001');
    fireEvent.click(within(review).getByRole('button', { name: '確かめるを閉じる' }));

    // 読み直した返品の欄に新しい申し込みが増えるが、確かめる画面はまた開かない
    expect(await screen.findByRole('group', { name: THIRD_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: REVIEW_MOCK })).not.toBeInTheDocument();
  });

  it('申し込みが2件ある時、閉じた後は、選んだカードの返品の確かめる画面を開く', async () => {
    serve(() => listBody([returnDetail({ id: 'ret-new', number: 2, label: SECOND_LABEL }), returnDetail({ id: 'ret-old' })]));
    const { dialog } = await openList();

    fireEvent.click(within(card(dialog, LABEL)).getByRole('button', { name: '申し込みを確かめる' }));

    expect(await screen.findByRole('dialog', { name: REVIEW_MOCK })).toHaveAttribute('data-return-id', 'ret-old');
  });

  it('承認したら、返品の欄に戻って「承認しました。」を出し、中身を読み直して親に伝える', async () => {
    let current = listBody([returnDetail()]);
    serve(() => current);
    const { dialog, onChanged } = await openList();
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '申し込みを確かめる' }));
    const review = await screen.findByRole('dialog', { name: REVIEW_MOCK });
    current = listBody([returnDetail({ status: 'open', displayStatus: 'in_progress', marks: ['awaiting_items'] })]);

    fireEvent.click(within(review).getByRole('button', { name: '承認した（返送あり）' }));

    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).getByRole('status')).toHaveTextContent('承認しました。');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: '受け取りの代役' })).not.toBeInTheDocument();
    // 読み直した返品の欄は、承認した後の返品（受け取るなどのボタン）になる
    await waitFor(() => expect(buttonNames(card(reopened))).toEqual(['受け取る', '返品を取り消す']));
  });

  it('返送不要で承認したら、すぐ受け取りの画面を、その返品の番号つきで開く。閉じると「承認しました。」の返品の欄に戻る', async () => {
    let current = listBody([returnDetail()]);
    serve(() => current);
    const { dialog, onChanged } = await openList();
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '申し込みを確かめる' }));
    const review = await screen.findByRole('dialog', { name: REVIEW_MOCK });
    current = listBody([returnDetail({ status: 'open', displayStatus: 'in_progress', marks: ['awaiting_items'], returnMethod: 'not_required' })]);

    fireEvent.click(within(review).getByRole('button', { name: '承認した（返送不要）' }));

    const receive = await screen.findByRole('dialog', { name: '受け取りの代役' });
    expect(receive).toHaveAttribute('data-order-id', ORDER_ID);
    expect(receive).toHaveAttribute('data-return-id', 'ret-0001');
    expect(screen.queryByRole('dialog', { name: TITLE })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: REVIEW_MOCK })).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(within(receive).getByRole('button', { name: '受け取りを閉じる' }));
    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).getByRole('status')).toHaveTextContent('承認しました。');
  });

  it('お断りしたら、返品の欄に戻って「お断りしました。」を出し、中身を読み直して親に伝える', async () => {
    let current = listBody([returnDetail()]);
    serve(() => current);
    const { dialog, onChanged } = await openList();
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '申し込みを確かめる' }));
    const review = await screen.findByRole('dialog', { name: REVIEW_MOCK });
    // お断りした返品は返品の欄に出さない
    current = listBody([returnDetail({ status: 'declined', displayStatus: null })]);

    fireEvent.click(within(review).getByRole('button', { name: 'お断りした' }));

    const reopened = await screen.findByRole('dialog', { name: TITLE });
    expect(within(reopened).getByRole('status')).toHaveTextContent('お断りしました。');
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(reopened).getByText('この注文にはまだ返品がありません。')).toBeInTheDocument());
  });

  it('答えが分からないまま閉じた時は、閉じる前に親へ読み直しを頼む（承認かお断りが済んだかもしれない）', async () => {
    serve(() => listBody([returnDetail()]));
    const { dialog, onChanged } = await openList();
    fireEvent.click(within(card(dialog)).getByRole('button', { name: '申し込みを確かめる' }));
    const review = await screen.findByRole('dialog', { name: REVIEW_MOCK });

    fireEvent.click(within(review).getByRole('button', { name: '確かめるの答えが分からない' }));
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(within(review).getByRole('button', { name: '確かめるを閉じる' }));
    await screen.findByRole('dialog', { name: TITLE });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
