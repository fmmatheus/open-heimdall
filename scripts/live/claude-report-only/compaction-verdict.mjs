// Verdict rules of the compaction live check (e2e-compaction.mjs), kept free of side effects so tests can import them.

// A malformed submission gets at most two format repairs (the initial call plus two retries).
export const FORMAT_REPAIR_LIMIT = 2;

// Format corrections actually observed: calls rejected as a repairable `format` error before the accepted call.
// `calls` has the shape of the evidence field `submissionCalls` ({ accepted, result: { accepted, code, repairable } }).
// The count comes from those observed calls only; the run state's repair counter is cleared by the time evidence is read.
export function countFormatCorrections(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const accepted = list.findIndex(call => call?.accepted === true);
  const before = accepted < 0 ? list : list.slice(0, accepted);
  return before.filter(call => call?.result?.accepted === false && call.result.repairable === true && call.result.code === 'format').length;
}

// Pass needs at least one check, every check true, no failure while waiting for the workflow and no compaction request error.
// Only null or undefined means no failure was recorded; any other value, including an empty message, false or 0, is a failure.
export function compactionVerdict({ checks, waitFailure = null, compactionError = null }) {
  const values = Object.values(checks ?? {});
  const pass = values.length > 0 && values.every(value => value === true) && waitFailure == null && compactionError == null;
  return { pass, exitCode: pass ? 0 : 1 };
}
