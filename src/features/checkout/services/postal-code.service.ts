import {
  extractAddressFromZipCloud,
  normalizePostalCode,
  type PostalAddressSuggestion,
} from '@/features/checkout/utils/postal-code.util';

const POSTAL_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const ZIPCLOUD_TIMEOUT_MS = 5000;

interface PostalCacheEntry {
  address: PostalAddressSuggestion;
  expiresAt: number;
}

const postalAddressCache = new Map<string, PostalCacheEntry>();
const inFlightRequests = new Map<string, Promise<PostalAddressSuggestion | null>>();

function getCachedAddress(postalCode: string): PostalAddressSuggestion | null {
  const cached = postalAddressCache.get(postalCode);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    postalAddressCache.delete(postalCode);
    return null;
  }

  return cached.address;
}

function setCachedAddress(postalCode: string, address: PostalAddressSuggestion) {
  postalAddressCache.set(postalCode, {
    address,
    expiresAt: Date.now() + POSTAL_CACHE_TTL_MS,
  });
}

export async function fetchAddressByPostalCode(postalCode: string): Promise<PostalAddressSuggestion | null> {
  const normalizedPostalCode = normalizePostalCode(postalCode);
  if (normalizedPostalCode.length !== 7) {
    return null;
  }

  const cachedAddress = getCachedAddress(normalizedPostalCode);
  if (cachedAddress) {
    return cachedAddress;
  }

  const pendingRequest = inFlightRequests.get(normalizedPostalCode);
  if (pendingRequest) {
    return pendingRequest;
  }

  const lookupPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ZIPCLOUD_TIMEOUT_MS);

    try {
      const response = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${normalizedPostalCode}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`ZipCloud API request failed: ${response.status}`);
      }

      const payload = await response.json();
      const address = extractAddressFromZipCloud(payload);

      if (address) {
        setCachedAddress(normalizedPostalCode, address);
      }

      return address;
    } finally {
      clearTimeout(timeoutId);
      inFlightRequests.delete(normalizedPostalCode);
    }
  })();

  inFlightRequests.set(normalizedPostalCode, lookupPromise);

  return lookupPromise;
}
