import { render, screen } from '@testing-library/react';
import { OrderStatusGuidance } from '@/features/order-status/components/OrderStatusGuidance';

test.each(['none', 'verified'] as const)('%sには登録と問い合わせの2つの道を出す', (access) => {
  render(<OrderStatusGuidance access={access} orderId="order" orderNumber="ORD-1234ABCD" />);
  expect(screen.getByRole('heading', { name: '返品・キャンセルをご希望の方へ' })).toBeVisible();
  expect(screen.getByText('ご注文の時と同じメールアドレスで会員登録し、メールの確認を済ませると、このご注文が会員の注文履歴に入り、そこから返品・キャンセルを申し込めます。')).toBeVisible();
  expect(screen.getByText('会員登録をせずにお申し込みをご希望の方は、お問い合わせからご連絡ください。注文番号は入力済みで開きます。')).toBeVisible();
  expect(screen.getByRole('link', { name: '会員登録して申し込む' })).toHaveAttribute('href', '/login?tab=register');
  expect(screen.getByRole('link', { name: 'お問い合わせから申し込む' })).toHaveAttribute('href', '/contact?type=order&order=ORD-1234ABCD');
  expect(screen.queryByRole('link', { name: '会員の注文のページへ' })).not.toBeInTheDocument();
});

test('持ち主だけ会員の注文リンクを出す', () => {
  render(<OrderStatusGuidance access="member" orderId="order" orderNumber="ORD-1234ABCD" />);
  expect(screen.getByRole('heading', { name: '返品・キャンセルのお申し込み' })).toBeVisible();
  expect(screen.getByText('返品・キャンセルのお申し込みは、会員の注文のページで受け付けています。')).toBeVisible();
  expect(screen.getByRole('link', { name: '会員の注文のページへ' })).toHaveAttribute('href', '/account/orders/order');
  expect(screen.queryByRole('link', { name: '会員登録して申し込む' })).not.toBeInTheDocument();
});
