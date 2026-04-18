export const normalizePhoneNumber = (phoneNumber: string) =>
	phoneNumber
		.normalize('NFKC')
		.replace(/[ー−―‐ｰ]/g, '-')
		.replace(/[^0-9]/g, '')
		.slice(0, 11);

export const formatPhoneNumberInput = (phoneNumber: string) => {
	const digits = normalizePhoneNumber(phoneNumber);

	if (digits.length === 0) {
		return '';
	}

	if (/^(050|070|080|090|020)/.test(digits)) {
		if (digits.length <= 3) {
			return digits;
		}
		if (digits.length <= 7) {
			return `${digits.slice(0, 3)}-${digits.slice(3)}`;
		}
		return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
	}

	if (/^(0120|0570)/.test(digits)) {
		if (digits.length <= 4) {
			return digits;
		}
		if (digits.length <= 7) {
			return `${digits.slice(0, 4)}-${digits.slice(4)}`;
		}
		return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
	}

	if (/^(03|06)/.test(digits)) {
		if (digits.length <= 2) {
			return digits;
		}
		if (digits.length <= 6) {
			return `${digits.slice(0, 2)}-${digits.slice(2)}`;
		}
		return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
	}

	if (digits.length <= 4) {
		return digits;
	}
	if (digits.length <= 7) {
		return `${digits.slice(0, 4)}-${digits.slice(4)}`;
	}
	return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
};
