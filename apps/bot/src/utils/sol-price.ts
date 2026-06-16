let _solPriceCache: { price: number; time: number } | null = null;

/** SOL/USD from CoinGecko with 2 min cache. Fallback ~$140. */
export async function getSolPriceInUsdt(): Promise<number> {
  if (_solPriceCache && Date.now() - _solPriceCache.time < 120_000) {
    return _solPriceCache.price;
  }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    const price = (data as { solana?: { usd?: number } })?.solana?.usd || 140;
    _solPriceCache = { price, time: Date.now() };
    return price;
  } catch {
    return _solPriceCache?.price || 140;
  }
}