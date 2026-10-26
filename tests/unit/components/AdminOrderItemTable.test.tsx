import { fireEvent, render, screen, within } from '@testing-library/react';
import AdminOrderItemTable from '@/components/AdminOrderItemTable';
import type { AdminOrderItemRow } from '@/lib/orders/admin-orders/admin-order-types';

// Link は自分で移る部品。単体では移動を起こさず、押した時の振る舞い（行の onOpen を呼ばないこと）だけを確かめる
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props} onClick={(event) => event.preventDefault()}>{children}</a>
  ),
}));

const ORDER_A = 'a1b2c3d4-1111-4222-8333-444455556666';
const ORDER_B = 'b1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'c1111111-1111-4111-8111-111111111111';
const ITEM_2 = 'c2222222-2222-4222-8222-222222222222';

function row(patch: Partial<AdminOrderItemRow> = {}): AdminOrderItemRow {
  return {
    orderId: ORDER_A, orderNumber: 'ORD-A1B2C3D4', orderCreatedAt: '2026-10-20T01:00:00Z', customerName: '山田 花子', customerEmail: 'hanako@example.com',
    orderItemId: ITEM_1, itemName: 'シルクブラウス', color: '白', size: 'M', isExchange: false, status: 'ready', quantity: 2, unitPrice: 6400, lineAmount: 12800, refundAmount: 0,
    blockedReasons: [], needsAttention: false, ...patch,
  };
}

const HEADERS = ['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価', '合計金額', '返金額', 'ステータス'];

describe('AdminOrderItemTable', () => {
  test('FREQ-536-AC-01: 12列の見出しが決めた順で、見出しを保つスクロール領域に入る', () => {
    render(<AdminOrderItemTable rows={[row()]} onOpen={jest.fn()} />);

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(HEADERS);
    const region = screen.getByRole('region', { name: '注文一覧表' });
    expect(region).toHaveClass('overflow-auto');
    expect(region).toHaveAttribute('tabindex', '0');
    for (const header of screen.getAllByRole('columnheader')) expect(header).toHaveClass('sticky');
  });

  test('FREQ-536-AC-01: 注文の共通欄は全行に持ち、交換の行に（交換品）の印、金額は ¥12,800 の形、日付は日本時間', () => {
    render(<AdminOrderItemTable rows={[
      row(),
      row({ orderItemId: ITEM_1, status: 'shipped', quantity: 1, unitPrice: 6400, lineAmount: 6400, refundAmount: 1200 }),
      row({ orderItemId: ITEM_2, itemName: 'ウールコート', color: null, size: null, isExchange: true, unitPrice: 0, lineAmount: 0, status: 'in_production' }),
    ]} onOpen={jest.fn()} />);

    const [, ...bodyRows] = screen.getAllByRole('row');
    expect(bodyRows).toHaveLength(3);
    for (const bodyRow of bodyRows) {
      const cells = within(bodyRow).getAllByRole('cell');
      expect(cells).toHaveLength(12);
      expect(cells[0]).toHaveTextContent('ORD-A1B2C3D4');
      expect(cells[1]).toHaveTextContent('2026-10-20 10:00');
      expect(cells[2]).toHaveTextContent('山田 花子');
      expect(cells[3]).toHaveTextContent('hanako@example.com');
    }
    const first = within(bodyRows[0]).getAllByRole('cell');
    expect(first[4]).toHaveTextContent('シルクブラウス');
    expect(first[4]).not.toHaveTextContent('（交換品）');
    expect(first.slice(5, 12).map((cell) => cell.textContent)).toEqual(['白', 'M', '2', '¥6,400', '¥12,800', '¥0', '発送準備中']);
    expect(within(bodyRows[1]).getAllByRole('cell')[10]).toHaveTextContent('¥1,200');
    const exchange = within(bodyRows[2]).getAllByRole('cell');
    expect(exchange[4]).toHaveTextContent('ウールコート（交換品）');
    expect(exchange.slice(5, 7).map((cell) => cell.textContent)).toEqual(['-', '-']);
    expect(exchange[8]).toHaveTextContent('¥0');
    expect(exchange[11]).toHaveTextContent('受注生産中');
  });

  test('FREQ-536-AC-01: 顧客名が空なら「ゲスト」、メールが空なら「-」。要対応の注文にだけ「要対応」の印', () => {
    render(<AdminOrderItemTable rows={[
      row({ orderId: ORDER_B, orderNumber: 'ORD-B1B2C3D4', customerName: null, customerEmail: '', needsAttention: true }),
      row({ orderItemId: ITEM_2 }),
    ]} onOpen={jest.fn()} />);

    const [, guest, normal] = screen.getAllByRole('row');
    const cells = within(guest).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('ゲスト');
    expect(cells[3]).toHaveTextContent('-');
    expect(within(guest).getByText('要対応')).toBeInTheDocument();
    expect(within(normal).queryByText('要対応')).not.toBeInTheDocument();
  });

  test('FREQ-536-AC-01: 同じ明細の別ステータスの行を並べても key の警告を出さない', () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<AdminOrderItemTable rows={[row({ status: 'ready' }), row({ status: 'shipped' })]} onOpen={jest.fn()} />);
      expect(logged.mock.calls.filter(([message]) => String(message).includes('unique "key"'))).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  test('FREQ-536-AC-04: 注文IDは Link で、行は aria-label を持ちフォーカスできる', () => {
    render(<AdminOrderItemTable rows={[row()]} onOpen={jest.fn()} />);

    expect(screen.getByRole('link', { name: 'ORD-A1B2C3D4' })).toHaveAttribute('href', `/admin/orders/${ORDER_A}`);
    const tableRow = screen.getByRole('row', { name: 'ORD-A1B2C3D4 シルクブラウス の詳細を開く' });
    expect(tableRow).toHaveAttribute('tabindex', '0');
  });

  test('FREQ-536-AC-04: 行の押下で onOpen(注文ID)。Link・ボタン・入力の上の押下では呼ばない（Link の押下で二重に移らない）', () => {
    const onOpen = jest.fn();
    render(<AdminOrderItemTable rows={[row()]} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('link', { name: 'ORD-A1B2C3D4' }));
    expect(onOpen).not.toHaveBeenCalled();

    const tableRow = screen.getByRole('row', { name: 'ORD-A1B2C3D4 シルクブラウス の詳細を開く' });
    // 行の中のボタン・入力の上の押下も呼ばない
    const button = document.createElement('button');
    const input = document.createElement('input');
    within(tableRow).getAllByRole('cell')[4].append(button, input);
    fireEvent.click(button);
    fireEvent.click(input);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(within(tableRow).getAllByRole('cell')[4]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(ORDER_A);
  });

  test('FREQ-536-AC-04: 行にフォーカスがある時の Enter/Space で onOpen(注文ID)。ほかのキーと、Link の上の Enter では呼ばない', () => {
    const onOpen = jest.fn();
    render(<AdminOrderItemTable rows={[row({ orderId: ORDER_B, orderNumber: 'ORD-B1B2C3D4' })]} onOpen={onOpen} />);
    const tableRow = screen.getByRole('row', { name: 'ORD-B1B2C3D4 シルクブラウス の詳細を開く' });

    fireEvent.keyDown(tableRow, { key: 'a' });
    fireEvent.keyDown(tableRow, { key: 'Tab' });
    fireEvent.keyDown(screen.getByRole('link', { name: 'ORD-B1B2C3D4' }), { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(tableRow, { key: 'Enter' })).toBe(false);
    expect(onOpen).toHaveBeenLastCalledWith(ORDER_B);
    // Space は頁を送らないよう既定の動作を止める
    expect(fireEvent.keyDown(tableRow, { key: ' ' })).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
