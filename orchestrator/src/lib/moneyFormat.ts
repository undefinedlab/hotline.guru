/** Speech-friendly USDC amounts for TTS / SMS. */

export function formatSpokenUsdc(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) {
    return "zero USDC";
  }
  const cents = Math.round(amount * 100);
  if (cents <= 0) return "zero USDC";
  if (cents < 100) {
    return cents === 1 ? "1 cent" : `${cents} cents`;
  }
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  const dollarPart = dollars === 1 ? "1 dollar" : `${dollars} dollars`;
  if (rem === 0) return `${dollarPart} USDC`;
  const centPart = rem === 1 ? "1 cent" : `${rem} cents`;
  return `${dollarPart} and ${centPart} USDC`;
}
