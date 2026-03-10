export interface PostalAddressSuggestion {
  prefecture: string;
  city: string;
  address: string;
}

interface ZipCloudResult {
  address1?: string;
  address2?: string;
  address3?: string;
}

interface ZipCloudResponse {
  status?: number;
  results?: ZipCloudResult[] | null;
}

export const normalizePostalCode = (postalCode: string) =>
  postalCode
    .normalize('NFKC')
    .replace(/[ー−―‐ｰ]/g, '-')
    .replace(/[^0-9]/g, '');

export const formatPostalCodeInput = (postalCode: string) => {
  const digits = normalizePostalCode(postalCode).slice(0, 7);
  if (digits.length <= 3) {
    return digits;
  }
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
};

export const isCompletePostalCode = (postalCode: string) => normalizePostalCode(postalCode).length === 7;

export const extractAddressFromZipCloud = (payload: unknown): PostalAddressSuggestion | null => {
  const data = payload as ZipCloudResponse;
  if (data.status !== 200 || !data.results || data.results.length === 0) {
    return null;
  }

  const result = data.results[0];
  return {
    prefecture: result.address1 ?? '',
    city: result.address2 ?? '',
    address: result.address3 ?? '',
  };
};