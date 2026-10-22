import { parseContactPrefill } from '@/features/contact/contact-prefill';

test('種別と小文字の注文番号を受け取り大文字で返す', () => {
  expect(parseContactPrefill('?type=order&order=ord-a1b2c3d4')).toEqual({
    inquiryType: 'order',
    orderNumber: 'ORD-A1B2C3D4',
  });
});

test('許可した種別だけ受け、英数字でもG以降の番号は無視する', () => {
  const invalids = [
    '?type=unknown',
    '?type=ORDER',
    '?order=ORD-G1234567',
    '?order=ORD-ZZZZZZZZ',
  ];
  expect(invalids.map(parseContactPrefill)).toEqual([{}, {}, {}, {}]);
});

test('片方が不正でも正しい方の初期値は残す', () => {
  expect(parseContactPrefill('?type=unknown&order=ORD-A1B2C3D4')).toEqual({
    orderNumber: 'ORD-A1B2C3D4',
  });
  expect(parseContactPrefill('?type=order&order=ORD-ZZZZZZZZ')).toEqual({
    inquiryType: 'order',
  });
});

test('重複した項目とHTMLらしい値を無視する', () => {
  expect(parseContactPrefill('?type=order&type=other&order=%3Cscript%3E')).toEqual({});
});

test.each(['product', 'other'] as const)('%s の種別も受ける', (inquiryType) => {
  expect(parseContactPrefill(`?type=${inquiryType}`)).toEqual({ inquiryType });
});

test('注文番号の前後の空白を取り大文字にそろえる', () => {
  expect(parseContactPrefill('?order=%20%09ord-a1b2c3d4%0A%20')).toEqual({
    orderNumber: 'ORD-A1B2C3D4',
  });
});

test.each([
  '',
  '?',
  '?type=&order=',
  '?type=Order',
  '?type=%20order%20',
  '?order=%20%20',
  '?order=ORD-1234567',
  '?order=ORD-123456789',
  '?order=A1B2C3D4',
  '?order=ORD-A1B2%20C3D4',
  '?order=ORD-A1B2C3D4%0AX',
  '?order=ORD-１２３４５６７８',
  '?type=%3Cscript%3E&order=%3Cimg%20src%3Dx%3E',
])('空値・形式の合わない値は返さない: %s', (search) => {
  expect(parseContactPrefill(search)).toEqual({});
});

test.each([
  '?type=order&type=other&order=ORD-A1B2C3D4',
  '?type=order&type=order&order=ORD-A1B2C3D4',
  '?type=&type=order&order=ORD-A1B2C3D4',
])('種別が重複しても正しい注文番号は残す: %s', (search) => {
  expect(parseContactPrefill(search)).toEqual({ orderNumber: 'ORD-A1B2C3D4' });
});

test.each([
  '?type=product&order=ORD-A1B2C3D4&order=ORD-11112222',
  '?type=product&order=ORD-A1B2C3D4&order=ORD-A1B2C3D4',
  '?type=product&order=&order=ORD-A1B2C3D4',
])('注文番号が重複しても正しい種別は残す: %s', (search) => {
  expect(parseContactPrefill(search)).toEqual({ inquiryType: 'product' });
});

test('件名・お名前・メール・本文・tokenなどは読まない', () => {
  expect(parseContactPrefill(
    '?type=order&order=ORD-A1B2C3D4&subject=URL件名&name=URL氏名'
      + '&email=url%40example.com&message=URL本文&token=ignored&website=ignored',
  )).toEqual({ inquiryType: 'order', orderNumber: 'ORD-A1B2C3D4' });
  expect(parseContactPrefill('?subject=URL件名&token=ignored&email=url%40example.com')).toEqual({});
});
