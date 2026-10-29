import type { DiscountInput, DiscountResult } from './discount-types';
import { searchBestDiscountPlan } from './discount-search';

/** Pure entry point: the caller supplies all settings, purchase facts and time. */
export function calculateDiscounts(input: DiscountInput): DiscountResult { return searchBestDiscountPlan(input); }
