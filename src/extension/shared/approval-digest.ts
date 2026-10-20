/*
 * The identity of the content an owner reviewed before approving a request whose compact card was shortened. The panel
 * computes it from the complete request it loaded; the service computes it again from a fresh complete read and refuses
 * the approval when the two differ. Both sides use Web Crypto, which the panel's browser and Node provide alike.
 */

/** The request fields the owner reads, as the service returns them (control characters already replaced). */
export interface ReviewedContent {
  question: string;
  scope: string;
  completedWork: string;
  verification: readonly string[];
  artifacts: readonly string[];
  onApprove: readonly string[];
  onRequestChanges: readonly string[];
}

/** What a decision names as the reviewed material: the request, its reviewed revision and a digest of its complete content. */
export interface ReviewedBinding {
  requestId: string;
  revision: { head: string; digest: string };
  contentDigest: string;
}

export const CONTENT_DIGEST = /^[0-9a-f]{64}$/;

/** SHA-256 over the fields in a fixed order and a fixed encoding, as lowercase hexadecimal. */
export async function approvalContentDigest(content: ReviewedContent): Promise<string> {
  const canonical = JSON.stringify([
    content.question, content.scope, content.completedWork,
    content.verification, content.artifacts, content.onApprove, content.onRequestChanges,
  ]);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
