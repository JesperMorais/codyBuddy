const DENY_PATTERNS = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])secrets?(\.|[\\/])/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa(\.|$)/i,
];

const SECRET_REGEXES: RegExp[] = [
  /\b(sk|sk-ant|sk-proj|sk-test|sk-live)-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bghs_[A-Za-z0-9]{36}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
];

export function isDeniedFile(path: string): boolean {
  return DENY_PATTERNS.some((re) => re.test(path));
}

export function scrubSecrets(input: string): { text: string; hits: number } {
  let hits = 0;
  let text = input;
  for (const re of SECRET_REGEXES) {
    text = text.replace(re, () => {
      hits += 1;
      return "<REDACTED-SECRET>";
    });
  }
  return { text, hits };
}

export function makeMiniDiff(prev: string, next: string, maxLines: number): string {
  if (prev === next) return "";
  const prevLines = prev.split("\n");
  const nextLines = next.split("\n");
  const out: string[] = [];
  const max = Math.max(prevLines.length, nextLines.length);
  for (let i = 0; i < max; i++) {
    if (prevLines[i] === nextLines[i]) continue;
    if (prevLines[i] !== undefined) out.push(`- ${prevLines[i]}`);
    if (nextLines[i] !== undefined) out.push(`+ ${nextLines[i]}`);
    if (out.length >= maxLines) {
      out.push(`... (truncated at ${maxLines} lines)`);
      break;
    }
  }
  return out.join("\n");
}
