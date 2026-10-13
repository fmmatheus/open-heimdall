import { maskSecrets } from '../redaction.js';

/**
 * Builds the sanitizer applied to everything a coordinator process writes. Secrets are asked for on every call so
 * values learned after startup (the coordinator key, run owner tokens) are covered; only values the process holds
 * can be masked, whatever their length, plus Authorization-style values and URL user information by pattern.
 */
export function createOutputSanitizer(secrets: () => Iterable<string | undefined>): (text: string) => string {
  return text => {
    const known = new Set<string>();
    try { for (const secret of secrets()) if (secret) known.add(secret); }
    catch { /* A failing source must not stop output; the pattern masks still apply. */ }
    return maskSecrets(text, known);
  };
}

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

/**
 * Routes every `process.stdout`/`process.stderr` write through `sanitize` until the returned function restores the
 * original writers. Binary chunks are decoded as UTF-8 so their text is sanitized as well.
 */
export function sanitizeProcessOutput(sanitize: (text: string) => string, streams: Array<Pick<NodeJS.WriteStream, 'write'>> = [process.stdout, process.stderr]): () => void {
  const originals = streams.map(stream => stream.write);
  streams.forEach((stream, index) => {
    const original = originals[index] as unknown as Write;
    (stream as { write: Write }).write = function (this: unknown, chunk, ...rest) {
      const clean = typeof chunk === 'string' ? sanitize(chunk) : sanitize(Buffer.from(chunk).toString('utf8'));
      return original.call(stream, clean, ...rest);
    };
  });
  return () => { streams.forEach((stream, index) => { stream.write = originals[index]!; }); };
}
