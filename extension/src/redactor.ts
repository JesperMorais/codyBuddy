const DENY_PATTERNS = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])secrets?(\.|[\\/])/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa(\.|$)/i,
  /(^|[\\/])id_(ed25519|ecdsa|dsa)(\.|$)/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])(\.netrc|_netrc)$/i,
  /(^|[\\/])\.pgpass$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.git[\\/]config$/i,
  /(^|[\\/])\.aws[\\/](credentials|config)$/i,
  /\.kubeconfig$/i,
  /(^|[\\/])kubeconfig$/i,
  /(^|[\\/])\.kube[\\/]config$/i,
  /\.ovpn$/i,
  /(^|[\\/])wg\d*\.conf$/i,
  /(^|[\\/])\.ssh[\\/]config$/i,
  /\.ppk$/i,
  /\.kdbx?$/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.?composer[\\/]auth\.json$/i,
];

const SECRET_REGEXES: RegExp[] = [
  // Issue #103: the prior single-line `(sk|sk-ant|sk-proj|sk-test|sk-live)-…{20,}`
  // had two flaws — alternation is leftmost-first so every named branch was
  // dead behind `sk`, and the 20-char `[A-Za-z0-9_-]+` tail over-redacted
  // benign kebab-case identifiers (`sk-shadow-large-rounded-with-blue-tint`,
  // `sk-deploy-staging-canary-2026-05-07`, etc.). Split into per-shape
  // regexes that match real key formats more precisely.
  // Anthropic: production keys are `sk-ant-api03-{~95 b64ish}`. The
  // `sk-ant-` prefix is itself a very specific signal — pair it with a
  // 20-char tail so internal/test fixtures (e.g. `sk-ant-{25 b64ish}`)
  // also match without the false-positive surface a bare `sk-` would have.
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI project / admin / test / live keys: hyphenated prefix, then a
  // long opaque tail. The named prefixes alone discriminate against a
  // programmer's kebab-case identifier — `sk-proj-…` is essentially never
  // a class name.
  /\bsk-(?:proj|admin|test|live)-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI legacy keys: `sk-{48 b64-ish chars, no internal hyphens}`. The
  // "no hyphens" guard is what distinguishes a real key from kebab-case
  // identifiers like `sk-shadow-large-rounded-with-blue-tint` /
  // `sk-deploy-staging-canary-2026-05-07`.
  /\bsk-[A-Za-z0-9]{40,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bghs_[A-Za-z0-9]{36}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(sk|rk|pk)_live_[0-9A-Za-z]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/@]+:[^\s@]+@/gi,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // Issue #163: prefix is `*` (zero-or-more) so a bare `PASSWORD=`,
  // `TOKEN=`, `SECRET=`, `KEY=`, `API=` is also caught — not just the
  // qualified `DB_PASSWORD=` / `JWT_SECRET=` form. `\b` keeps it from
  // firing mid-identifier (e.g. `myPASSWORD=` doesn't match because
  // `y`→`P` is not a word boundary).
  /\b[A-Z0-9_]*(?:API|TOKEN|SECRET|PASSWORD|KEY)\s*=\s*['"]?[^\s'"]+/g,
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
