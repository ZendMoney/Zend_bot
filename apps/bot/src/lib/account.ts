/** Strip non-digits from account numbers (Whisper adds dashes, spaces, dots) */
export function sanitizeAccountNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/\D/g, '');
}