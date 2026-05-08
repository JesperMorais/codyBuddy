// Daemon-side redactor — Task 10.9.
//
// The extension already redacts before sending triggers via the
// trigger-comment / sidebar-ask paths (Task 1.6's redactor in
// extension/src/redactor.ts). The audio path is different: mic input
// → Whisper → daemon assembles the LLM payload directly, so the
// extension's redactor never gets a chance to run. This module is
// a copy of the same patterns so the daemon can scrub secrets and
// reject denied files when assembling conversation-context payloads.
//
// Keep these patterns in sync with extension/src/redactor.ts. The
// readme-consistency canary doesn't pin this — duplication is small
// and a divergence test would just block reasonable updates. If the
// list grows enough to be a real source of drift, lift both into a
// shared package.

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
  /\b(sk|sk-ant|sk-proj|sk-test|sk-live)-[A-Za-z0-9_-]{20,}\b/g,
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
