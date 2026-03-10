import {
  extractAddressFromZipCloud,
  normalizePostalCode,
  type PostalAddressSuggestion,
} from '@/features/checkout/utils/postal-code.util';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getRedisJson, setRedisJson } from '@/lib/cache/redis-cache';

const POSTAL_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const REDIS_CACHE_TTL_SECONDS = 60 * 60 * 24;
const ZIPCLOUD_TIMEOUT_MS = 5000;
const REDIS_KEY_PREFIX = 'checkout:postal_code';

interface PostalCacheEntry {
  address: PostalAddressSuggestion;
  expiresAt: number;
}

const postalAddressCache = new Map<string, PostalCacheEntry>();
const inFlightRequests = new Map<string, Promise<PostalAddressSuggestion | null>>();

interface PostalCodeCacheRow {
  postal_code: string;
  prefecture: string;
  city: string;
  address: string;
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

function getRedisCacheKey(postalCode: string) {
  return `${REDIS_KEY_PREFIX}:${postalCode}`;
}

async function getSupabaseClient() {
  try {
    return await createServiceRoleClient();
  } catch {
    return await createClient();
  }
}

function mapRowToAddress(row: PostalCodeCacheRow): PostalAddressSuggestion {
  return {
    prefecture: row.prefecture,
    city: row.city,
    address: row.address,
  };
}

async function findAddressInDb(postalCode: string): Promise<PostalAddressSuggestion | null> {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('postal_code_cache')
    .select('postal_code,prefecture,city,address')
    .eq('postal_code', postalCode)
    .maybeSingle<PostalCodeCacheRow>();

  if (error || !data) {
    return null;
  }

  return mapRowToAddress(data);
}

async function upsertAddressToDb(postalCode: string, address: PostalAddressSuggestion): Promise<void> {
  const supabase = await getSupabaseClient();
  await supabase.from('postal_code_cache').upsert(
    {
      postal_code: postalCode,
      prefecture: address.prefecture,
      city: address.city,
      address: address.address,
      source: 'zipcloud',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'postal_code' },
  );
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

  const dbAddress = await findAddressInDb(normalizedPostalCode);
  if (dbAddress) {
    setCachedAddress(normalizedPostalCode, dbAddress);
    await setRedisJson(getRedisCacheKey(normalizedPostalCode), dbAddress, REDIS_CACHE_TTL_SECONDS);
    return dbAddress;
  }

  const redisAddress = await getRedisJson<PostalAddressSuggestion>(getRedisCacheKey(normalizedPostalCode));
  if (redisAddress) {
    setCachedAddress(normalizedPostalCode, redisAddress);
    return redisAddress;
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
        await upsertAddressToDb(normalizedPostalCode, address);
        await setRedisJson(getRedisCacheKey(normalizedPostalCode), address, REDIS_CACHE_TTL_SECONDS);
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
