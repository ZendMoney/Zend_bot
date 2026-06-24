import type { AirbillsClient, AirbillsDataPlan, AirbillsCablePackage } from '@zend/airbills-client';

/** Fetch AirBills data plans and filter by networkId. */
export async function getDataPlansForNetwork(
  client: AirbillsClient,
  network: string
): Promise<AirbillsDataPlan[]> {
  const networkId = networkToId(network);
  try {
    const plans = await client.listInternet();
    const filtered = plans.filter((p) => p.networkId === networkId);
    console.log(`[AirBills] Data plans loaded for network ${network} (${networkId}): ${filtered.length}`);
    return filtered;
  } catch (err: any) {
    console.warn(`[AirBills] getDataPlansForNetwork failed:`, err.message);
    return [];
  }
}

/** Fetch AirBills cable packages and filter by provider. */
export async function getCablePackagesForProvider(
  client: AirbillsClient,
  provider: string
): Promise<AirbillsCablePackage[]> {
  const normalized = provider.toLowerCase();
  try {
    const packages = await client.listCable();
    const filtered = packages.filter(
      (p) => p.provider.toLowerCase() === normalized || normalized.includes(p.provider.toLowerCase())
    );
    console.log(`[AirBills] Cable packages loaded for provider ${provider}: ${filtered.length}`);
    return filtered;
  } catch (err: any) {
    console.warn(`[AirBills] getCablePackagesForProvider failed:`, err.message);
    return [];
  }
}

function networkToId(network: string): string {
  const map: Record<string, string> = {
    mtn: '01',
    glo: '02',
    etisalat: '03',
    airtel: '04',
  };
  return map[network.toLowerCase()] || network;
}
