import {
  extractAddressFromZipCloud,
  normalizePostalCode,
  type PostalAddressSuggestion,
} from '@/features/checkout/utils/postal-code.util';
import { createServiceRoleClient } from '@/lib/supabase/server';

const POSTAL_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const ZIPCLOUD_TIMEOUT_MS = 5000;

interface PostalCacheEntry {
  address: PostalAddressSuggestion;
  expiresAt: number;
}

const postalAddressCache = new Map<string, PostalCacheEntry>();
const inFlightRequests = new Map<string, Promise<PostalAddressSuggestion | null>>();
let serviceRoleClientPromise: ReturnType<typeof createServiceRoleClient> | null = null;

type PostalCodeCacheRow = {
  prefecture: string;
  city: string;
  address: string;
  updated_at: string;
};

function getServiceRoleClient() {
  if (!serviceRoleClientPromise) {
    serviceRoleClientPromise = createServiceRoleClient();
  }

  return serviceRoleClientPromise;
}

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

function isDbCacheFresh(updatedAt: string): boolean {
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() - timestamp < POSTAL_CACHE_TTL_MS;
}

async function getDbCachedAddress(postalCode: string): Promise<PostalAddressSuggestion | null> {
  try {
    const supabase = await getServiceRoleClient();
    const { data, error } = await supabase
      .from('postal_code_cache')
      .select('prefecture, city, address, updated_at')
      .eq('postal_code', postalCode)
      .maybeSingle<PostalCodeCacheRow>();

    if (error || !data || !isDbCacheFresh(data.updated_at)) {
      return null;
    }

    return {
      prefecture: data.prefecture,
      city: data.city,
      address: data.address,
    };
  } catch (error) {
    console.warn('Failed to read postal_code_cache:', error);
    return null;
  }
}

async function setDbCachedAddress(
  postalCode: string,
  address: PostalAddressSuggestion
): Promise<void> {
  try {
    const supabase = await getServiceRoleClient();
    const { error } = await supabase.from('postal_code_cache').upsert(
      {
        postal_code: postalCode,
        prefecture: address.prefecture,
        city: address.city,
        address: address.address,
        source: 'zipcloud',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'postal_code' }
    );

    if (error) {
      console.warn('Failed to upsert postal_code_cache:', error);
    }
  } catch (error) {
    console.warn('Failed to upsert postal_code_cache:', error);
  }
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
    const dbCachedAddress = await getDbCachedAddress(normalizedPostalCode);
    if (dbCachedAddress) {
      setCachedAddress(normalizedPostalCode, dbCachedAddress);
      return dbCachedAddress;
    }

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
        await setDbCachedAddress(normalizedPostalCode, address);
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
