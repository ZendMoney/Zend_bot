let _auddPriceCache: { price: number; time: number } | null = null;

export async function getAuddPriceInUsdt(): Promise<number> {
  if (_auddPriceCache && Date.now() - _auddPriceCache.time < 120000) {
    return _auddPriceCache.price;
  }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=novatti-australian-digital-dollar&vs_currencies=usd');
    const data = await res.json();
    const price = (data as any)?.['novatti-australian-digital-dollar']?.usd;
    if (typeof price === 'number' && price > 0) {
      _auddPriceCache = { price, time: Date.now() };
      return price;
    }
    throw new Error(`CoinGecko returned invalid AUDD price: ${JSON.stringify(data)}`);
  } catch (err: any) {
    if (_auddPriceCache) {
      return _auddPriceCache.price;
    }
    throw new Error(`Failed to fetch AUDD price from CoinGecko: ${err.message}`);
  }
}