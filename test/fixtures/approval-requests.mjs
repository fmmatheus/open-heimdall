/*
 * Synthetic approval requests that are legal under the executor-result contract (text 4000 characters, lists 20 entries,
 * 32 KiB of JSON) and longer than the compact projections that run views carry (text 1500, entry 400, list 10).
 * Each distinctive marker sits beyond a compact limit, so a view that dropped it hid something the owner must see.
 */

export const COMPACT = { text: 1500, entry: 400, list: 10 };
export const CANONICAL = { text: 4000, list: 20, payload: 32 * 1024 };

const pad = (prefix, length, fill = '.') => (prefix + fill.repeat(Math.max(0, length - prefix.length))).slice(0, length);
/** `head`, filler up to `at`, then `marker` and filler up to `length`; the marker starts at index `at`. */
const withMarker = (head, at, marker, length) => pad(pad(head, at) + marker, length);

/** The size the contract measures: the whole submission, including its status field. */
export const submissionBytes = request => Buffer.byteLength(JSON.stringify({ status: 'approval-required', ...request }), 'utf8');

/** A scope of about 1,900 characters whose authorizing action starts after character 1,500, and lists that exceed the compact limits. */
export function hiddenTailRequest() {
  const scope = withMarker('Authorizes the reviewed commit only → ', 1510, 'ACTION-AFTER-1500: also drop the legacy_users table. ', 1900);
  const request = {
    question: 'Authorize the data migration, including the late action named in the scope?',
    scope,
    completedWork: withMarker('Migration written and run on a copy. ', 1600, 'WORK-TAIL-1600: rollback rehearsed. ', 1700),
    verification: Array.from({ length: 14 }, (_, index) => (index === 2
      ? withMarker('check-2: long evidence ', 700, 'EVIDENCE-TAIL-700: all rows reconciled. ', 900)
      : `check-${index}: passed${index === 12 ? ' (EVIDENCE-ENTRY-12 beyond the tenth entry, café ✓)' : ''}`)),
    artifacts: Array.from({ length: 12 }, (_, index) => `src/artifact-${index}.ts${index === 11 ? ' ARTIFACT-ENTRY-11' : ''}`),
    onApprove: Array.from({ length: 15 }, (_, index) => (index === 0
      ? withMarker('merge the migration ', 500, 'ACTION-ENTRY-TAIL-500: then delete the branch. ', 650)
      : `approve-step-${index}${index === 13 ? ' PROPOSED-ACTION-13: purge the cache' : ''}`)),
    onRequestChanges: Array.from({ length: 11 }, (_, index) => `change-step-${index}${index === 10 ? ' CHANGES-ENTRY-10' : ''}`),
  };
  return request;
}

/** A request whose submission is exactly at the 32 KiB payload limit, with texts and lists at their maxima. */
export function nearLimitRequest() {
  const text = marker => {
    const end = `[${marker}-END]`;
    return withMarker('Full ' + marker + ' ', 1510, `${marker}-AFTER-1500 `, CANONICAL.text - end.length) + end;
  };
  const request = {
    question: text('QUESTION'),
    scope: text('SCOPE'),
    completedWork: text('WORK'),
    verification: Array.from({ length: 20 }, (_, index) => pad(`verification-${index} `, 250)),
    artifacts: Array.from({ length: 20 }, (_, index) => pad(`artifact-${index} `, 250)),
    onApprove: Array.from({ length: 20 }, (_, index) => pad(`approve-${index} `, 250)),
    onRequestChanges: Array.from({ length: 20 }, (_, index) => pad(`changes-${index} `, 250)),
  };
  const remaining = CANONICAL.payload - submissionBytes(request);
  if (remaining < 0) throw new Error('The near-limit request fixture is over the payload limit');
  // The remaining bytes go to one entry beyond the compact list limit, so the request ends exactly at the limit.
  request.onRequestChanges[19] = pad(request.onRequestChanges[19], 250 + remaining);
  request.onRequestChanges[19] = request.onRequestChanges[19].slice(0, -12) + ' LAST-ENTRY!';
  return request;
}
