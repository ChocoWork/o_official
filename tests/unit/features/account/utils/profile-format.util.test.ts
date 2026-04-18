import { formatPhoneNumberInput, normalizePhoneNumber } from '@/features/account/utils/profile-format.util';

describe('profile-format util', () => {
	test('携帯番号を 090-1234-5678 形式に整形する', () => {
		expect(formatPhoneNumberInput('09012345678')).toBe('090-1234-5678');
		expect(formatPhoneNumberInput('090-1234')).toBe('090-1234');
	});

	test('市外局番 03 の固定電話を 03-1234-5678 形式に整形する', () => {
		expect(formatPhoneNumberInput('0312345678')).toBe('03-1234-5678');
	});

	test('0120 番号を 0120-123-456 形式に整形する', () => {
		expect(formatPhoneNumberInput('0120123456')).toBe('0120-123-456');
	});

	test('電話番号は数字のみを正規化する', () => {
		expect(normalizePhoneNumber('０９０-１２３４-５６７８abc')).toBe('09012345678');
	});
});
