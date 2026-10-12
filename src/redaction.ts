/**
 * Masks known secret values, URL user information and Authorization-style values in diagnostic text.
 * Longer secrets are replaced first so a secret that contains another is masked as a whole.
 */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret) result = result.split(secret).join('[redacted]');
  return result
    .replace(/(:\/\/)[^/?#\s@]*@/g, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]');
}
