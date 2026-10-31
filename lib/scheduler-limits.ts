// Keep the validation headroom and the FSRS configuration in agreement.
export const MAX_REVIEW_INTERVAL_DAYS = 36_500;
// JavaScript's Date limit, less the longest interval and one day for local-time arithmetic.
export const MAX_REVIEW_TIME_MS = 8.64e15 - (MAX_REVIEW_INTERVAL_DAYS + 1) * 86_400_000;
