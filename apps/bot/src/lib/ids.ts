export function generateTxId(): string {
  return 'ZND-' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

export function generateReferralCode(): string {
  return 'ZND' + Math.random().toString(36).substring(2, 6).toUpperCase();
}