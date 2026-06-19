import type { AirbillsClient, AirbillsPlan } from '@zend/airbills-client';

/** Try common AirBills service slugs until plans are returned. */
export async function getDataPlansForNetwork(
  client: AirbillsClient,
  network: string
): Promise<AirbillsPlan[]> {
  const slugs = [
    `data-${network}`,
    `${network}-data`,
    network,
    'data',
  ];

  for (const slug of slugs) {
    try {
      const plans = await client.getPlans(slug);
      if (plans.length > 0) {
        console.log(`[AirBills] Data plans loaded via slug "${slug}" (${plans.length} plans)`);
        return plans;
      }
    } catch (err: any) {
      console.warn(`[AirBills] getPlans("${slug}") failed:`, err.message);
    }
  }

  return [];
}