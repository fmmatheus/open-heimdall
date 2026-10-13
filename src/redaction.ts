/**
 * Replaces every occurrence of each known secret value, whatever its length, in one pass. At each position the longest
 * secret wins, so a secret that contains another is masked as a whole, and a replacement is never scanned again, so a
 * short secret cannot alter the `[redacted]` marker left by another.
 */
export function maskKnownSecrets(text: string, secrets: Iterable<string>): string {
  const known = [...new Set(secrets)].filter(secret => secret).sort((a, b) => b.length - a.length);
  if (!known.length) return text;
  return text.replace(new RegExp(known.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), '[redacted]');
}

/**
 * Masks known secret values, URL user information and Authorization-style values in diagnostic text.
 * Longer secrets are replaced first so a secret that contains another is masked as a whole.
 */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  return maskKnownSecrets(text, secrets)
    .replace(/(:\/\/)[^/?#\s@]*@/g, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]');
}
