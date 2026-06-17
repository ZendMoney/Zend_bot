/**
 * Load .env before any module that reads process.env.
 * Import this file first from index.ts (and only from index.ts).
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });