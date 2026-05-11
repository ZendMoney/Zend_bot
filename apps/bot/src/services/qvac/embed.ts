/**
 * QVAC Embeddings Service
 * Semantic search over transaction history using local embeddings.
 */

import { embed, getEmbedModelId } from './index.js';

interface EmbeddedDoc {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, any>;
}

// In-memory vector store per user (replace with DB in production)
const userVectorStores = new Map<string, EmbeddedDoc[]>();

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generate an embedding for a single text string.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const modelId = await getEmbedModelId();
  if (!modelId) {
    console.warn('[QVAC Embed] Model not loaded');
    return null;
  }

  try {
    const result = await embed({ modelId, text });
    return result.embedding;
  } catch (err: any) {
    console.error('[QVAC Embed] Failed:', err.message || err);
    return null;
  }
}

/**
 * Index a user's transaction for semantic search.
 */
export async function indexTransaction(
  userId: string,
  txId: string,
  description: string,
  metadata?: Record<string, any>
): Promise<void> {
  const embedding = await generateEmbedding(description);
  if (!embedding) return;

  const store = userVectorStores.get(userId) || [];
  store.push({ id: txId, text: description, embedding, metadata });
  userVectorStores.set(userId, store);
}

/**
 * Semantic search over a user's transaction history.
 * Returns top-k most relevant transactions.
 */
export async function searchTransactions(
  userId: string,
  query: string,
  topK: number = 5
): Promise<Array<{ id: string; text: string; score: number; metadata?: Record<string, any> }>> {
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) return [];

  const store = userVectorStores.get(userId) || [];
  if (store.length === 0) return [];

  const scored = store.map((doc) => ({
    id: doc.id,
    text: doc.text,
    score: cosineSimilarity(queryEmbedding, doc.embedding),
    metadata: doc.metadata,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Clear a user's vector store.
 */
export function clearUserEmbeddings(userId: string): void {
  userVectorStores.delete(userId);
}
