/** Parse `90`, `90s`, `5m`, `2h` into milliseconds. Bare numbers are seconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration "${input}". Use forms like 30s, 5m, 2h.`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"] as number;
  return Math.round(Number(m[1]) * unit);
}
