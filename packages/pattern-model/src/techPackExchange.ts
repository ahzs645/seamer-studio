/** Authored quote: one unit of fromCurrency equals rate units of toCurrency on date. */
export interface TechPackExchangeRate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  date: string;
  source: string;
}

export function techPackExchangeProblem(quote: TechPackExchangeRate): string | null {
  if (!/^[A-Z]{3}$/.test(quote.fromCurrency) || !/^[A-Z]{3}$/.test(quote.toCurrency)) return 'Use three-letter currency codes.';
  if (quote.fromCurrency === quote.toCurrency) return 'Choose different currencies.';
  if (!Number.isFinite(quote.rate) || quote.rate <= 0) return 'Exchange rate must be a positive finite number.';
  const parsedDate = new Date(`${quote.date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quote.date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== quote.date) return 'Enter a valid quote date.';
  if (!quote.source.trim()) return 'Record the quote source.';
  return null;
}

/** Never infer cross-rates, inverses or live rates. Unknown costs remain unknown. */
export function convertTechPackAmount(amount: number | null, fromCurrency: string, quote: TechPackExchangeRate): number | null {
  if (amount === null || !Number.isFinite(amount) || techPackExchangeProblem(quote) || quote.fromCurrency !== fromCurrency) return null;
  const converted = amount * quote.rate;
  return Number.isFinite(converted) ? converted : null;
}
