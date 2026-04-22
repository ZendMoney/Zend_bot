import { Hono } from 'hono';
import { db, transactions, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { PAJClient } from '@zend/paj-client';

const pajClient = new PAJClient({
  apiKey: process.env.PAJ_API_KEY || '',
  apiSecret: process.env.PAJ_API_SECRET || '',
  baseUrl: process.env.PAJ_BASE_URL || 'https://api.paj.cash',
});

export const pajWebhookRoute = new Hono();

// POST /webhooks/paj
pajWebhookRoute.post('/paj', async (c) => {
  const signature = c.req.header('x-paj-signature');
  const body = await c.req.text();

  // Verify signature
  if (!signature || !pajClient.verifyWebhookSignature(body, signature)) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const event = pajClient.parseWebhookEvent(body);
  console.log('PAJ webhook received:', event.type, event.reference);

  switch (event.type) {
    case 'onramp.deposit.confirmed': {
      // Naira deposited → credit USDT to wallet
      await handleOnRampConfirmed(event);
      break;
    }

    case 'onramp.deposit.failed': {
      // Deposit failed → notify user
      await handleOnRampFailed(event);
      break;
    }

    case 'offramp.settlement.confirmed': {
      // NGN settled to bank → mark transaction complete
      await handleOffRampConfirmed(event);
      break;
    }

    case 'offramp.settlement.failed': {
      // Settlement failed → refund USDT to user
      await handleOffRampFailed(event);
      break;
    }

    default:
      console.log('Unknown PAJ event type:', event.type);
  }

  return c.json({ received: true });
});

async function handleOnRampConfirmed(event: any) {
  // Find user by wallet address
  const user = await db.query.users.findFirst({
    where: eq(users.walletAddress, event.walletAddress),
  });

  if (!user) {
    console.error('User not found for wallet:', event.walletAddress);
    return;
  }

  // Create transaction record
  await db.insert(transactions).values({
    id: event.reference,
    userId: user.id,
    type: 'ngn_receive',
    status: 'completed',
    ngnAmount: event.ngnAmount?.toString(),
    toAmount: event.cryptoAmount,
    toMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    pajReference: event.reference,
    completedAt: new Date(),
  });

  // TODO: Send Telegram notification to user
  console.log(`Credited ${event.cryptoAmount} USDT to user ${user.id}`);
}

async function handleOnRampFailed(event: any) {
  console.log('On-ramp failed:', event.reference, event.reason);
  // TODO: Notify user
}

async function handleOffRampConfirmed(event: any) {
  // Find and update transaction
  const tx = await db.query.transactions.findFirst({
    where: eq(transactions.pajReference, event.reference),
  });

  if (!tx) {
    console.error('Transaction not found:', event.reference);
    return;
  }

  await db.update(transactions)
    .set({
      status: 'completed',
      completedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  // TODO: Send Telegram notification to user
  console.log(`Off-ramp completed: ${event.reference}`);
}

async function handleOffRampFailed(event: any) {
  const tx = await db.query.transactions.findFirst({
    where: eq(transactions.pajReference, event.reference),
  });

  if (!tx) {
    console.error('Transaction not found:', event.reference);
    return;
  }

  // Mark as failed
  await db.update(transactions)
    .set({
      status: 'failed',
      metadata: { failureReason: event.reason },
    })
    .where(eq(transactions.id, tx.id));

  // TODO: Refund USDT to user wallet
  // TODO: Notify user
  console.log(`Off-ramp failed, refund needed: ${event.reference}`);
}
