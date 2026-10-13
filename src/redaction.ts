/** A credential-shaped pattern and the text that stands in for each match. `$1`-style groups are expanded. */
export interface MaskRule {
  pattern: RegExp;
  replacement: string;
}

/** URL user information and `Bearer`/`Basic` values of at least six characters. */
export const AUTHORIZATION_RULES: readonly MaskRule[] = [
  { pattern: /(:\/\/)[^/?#\s@]*@/g, replacement: '$1[redacted]@' },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, replacement: '$1 [redacted]' },
];

/** A 64-digit hexadecimal capability. */
export const CAPABILITY_RULE: MaskRule = { pattern: /\b[0-9a-f]{64}\b/gi, replacement: '[redacted]' };

/** Diagnostic text: any `Bearer`/`Basic` value, scheme-prefixed URL user information and capabilities. */
export const DIAGNOSTIC_RULES: readonly MaskRule[] = [
  { pattern: /\b(Bearer|Basic)\s+[^\s'"]+/gi, replacement: '$1 [redacted]' },
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, replacement: '$1[redacted]@' },
  CAPABILITY_RULE,
];

interface Span {
  start: number;
  end: number;
  /** Null for a known value; otherwise the text the rule leaves in place of the span. */
  replacement: string | null;
}

function knownSpans(text: string, secrets: Iterable<string>): Span[] {
  const known = [...new Set(secrets)].filter(secret => secret).sort((a, b) => b.length - a.length);
  if (!known.length) return [];
  // A lookahead at every position finds overlapping occurrences too; the longest value wins at each start.
  const alternatives = known.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return [...text.matchAll(new RegExp(`(?=(${alternatives}))`, 'g'))].map(match => ({ start: match.index, end: match.index + match[1]!.length, replacement: null }));
}

function patternSpans(text: string, rules: readonly MaskRule[]): Span[] {
  const spans: Span[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    for (const match of text.matchAll(pattern)) {
      if (!match[0]) continue;
      spans.push({ start: match.index, end: match.index + match[0].length, replacement: rule.replacement.replace(/\$(\d)/g, (_, group: string) => match[Number(group)] ?? '') });
    }
  }
  return spans;
}

/**
 * Masks known secret values, whatever their length, and credential-shaped text in one pass over the original text.
 * Every span is located before any is replaced, so no replacement can alter the syntax another match relies on (a
 * secret `B` cannot turn `Bearer` into `[redacted]earer`, nor `:` destroy `://`). Overlapping spans are replaced as
 * one: by the stable marker of the first pattern among them, otherwise by `[redacted]`. A replacement is never scanned
 * again, so a short secret cannot alter the marker left by another.
 */
export function maskSecrets(text: string, secrets: Iterable<string>, rules: readonly MaskRule[] = AUTHORIZATION_RULES): string {
  const spans = [...knownSpans(text, secrets), ...patternSpans(text, rules)].sort((a, b) => a.start - b.start || b.end - a.end);
  if (!spans.length) return text;
  let result = '';
  let cursor = 0;
  for (let index = 0; index < spans.length;) {
    const first = spans[index]!;
    let end = first.end;
    let replacement = first.replacement;
    index += 1;
    while (index < spans.length && spans[index]!.start < end) {
      const next = spans[index]!;
      end = Math.max(end, next.end);
      replacement ??= next.replacement;
      index += 1;
    }
    result += text.slice(cursor, first.start) + (replacement ?? '[redacted]');
    cursor = end;
  }
  return result + text.slice(cursor);
}
