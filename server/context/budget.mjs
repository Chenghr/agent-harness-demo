// Provider tokenizers differ. This is an estimate plus an explicit safety margin,
// never a claim that a locally counted token equals a provider token.
export const estimateTokens = (text) =>
  Math.ceil([...String(text)].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : 0.3), 0));
export function contextBudget(profile) {
  const margin = Math.ceil(profile.contextWindow * 0.05);
  return {
    budget: profile.contextWindow,
    reserve: profile.maxOutput,
    margin,
    available: Math.max(0, profile.contextWindow - profile.maxOutput - margin),
    estimated: true,
  };
}
export function fitText(text, budget) {
  if (estimateTokens(text) <= budget) return text;
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
