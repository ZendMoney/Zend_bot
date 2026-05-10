import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';

// Connection string from env
const connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/zend';

// For migrations and queries
export const client = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 60 * 30,
});
export const db = drizzle(client, { schema });

// Helper to check connection
export async function checkConnection(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
