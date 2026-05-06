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
