# Compaction-safe submission provenance (feature 0008)

Validation record for proving the origin of a typed submission from the full native
message archive instead of the child's compacted active context. It separates three
kinds of evidence: automated tests, one standalone live smoke, and the coordinator
admission of the run that finished this work. No credential, transcript text or
store database is recorded here; identifiers are synthetic.

## Status

| Gate | State |
| --- | --- |
| Origin proof reads the full paged archive (regression tests) | **Passed**, automated |
| Null cursors accepted; repeated cursors and an exhausted bounded scan fail closed | **Passed**, automated |
| Unverifiable origin reported distinctly, never a format repair | **Passed**, automated |
| Submission accepted after a real native compaction (standalone smoke) | **Observed once** |
| Live harness verdict fails on failed evidence and counts observed corrections | **Fixed**, covered by tests |
| Coordinator admission of the finishing run: `structured-v1`, snapshot | **Read from the coordinator**, see [Coordinator admission](#coordinator-admission) |
| Final `npm run check`, `npm test`, `npm run build:extension` | See [Final checks](#final-checks) |
| Real quota behavior, installed build, coordinator-managed compaction run | **Not proven** (see [Not proven](#not-proven-and-remaining-limits)) |

## Defect

A submission is authenticated against the native caller (session, agent, message and
call ID) and the dispatch prompt that started the attempt. The origin proof read the
child's active context. When the host compacts a long child, the active context no
longer contains the dispatch prompt, so a genuine submission from a compacted child
lost its prompt and was denied. Separately, the message-history pager did not accept
the `null` cursor a server reports on the page past the end, and a cycle in the
cursors could be followed instead of rejected.

## Fix

- **Full archive.** The origin is proved by walking the native message archive
  through the paged `createMessageHistory` (`src/opencode/observer.ts`): the first
  page is requested newest first, later pages follow the opaque `cursor.next`. The
  caller message, its call and the dispatch prompt may sit on different pages; all
  caller, dispatch and attempt checks are kept.
- **Null cursors.** A `null` cursor is treated as absent.
- **Cycles.** A cursor equal to the current or an earlier one is rejected
  (`cursor_repeated`) before any message of that page is yielded, including an empty
  terminal page.
- **Bounded scan.** A proof found on the final permitted page is accepted without
  fetching another page. A scan that reaches the page cap without proof fails closed
  (`scan_exhausted`).
- **Distinct unverifiable origin.** When the bound child's origin cannot be verified,
  the call is denied with its own bounded message. It is not a format error, spends no
  repair, writes no receipt and leaves the binding usable; an attempt that ends after
  only such calls pauses naming the unverifiable origin. A wrong caller keeps the
  plain denial.

## Automated regression results

Key regressions (names abbreviated):

- `test/observer.test.mjs`: message history follows the opaque cursor in native order
  and sends the order only on the first page; null cursors are treated as absent;
  a repeated cursor is rejected even on an empty terminal page.
- `test/native-composition.test.mjs`: a compacted active context without the dispatch
  prompt still authenticates the genuine submission from the full archive; several
  compactions with the call and its prompt on different pages still authenticate; a
  reused child after compaction and a plugin restart accepts its own call and rejects
  a delayed call from an earlier dispatch; a cyclic archive page cannot authenticate a
  submission even with the exact call and prompt; a proof on the final permitted page
  is accepted without another cursor; unverifiable provenance is denied without a
  receipt, is not a format repair and does not block the genuine retry; an attempt that
  ends after only unverifiable calls pauses naming the unverifiable origin; a receipt
  proven from the full archive after compaction is replayed after a crash and advances
  exactly once.
- `test/live-harness.test.mjs`: the verdict of the compaction live check (below).

**Prior evidence, not rerun for this record:** an earlier full run on Node v22.22.3
reported tests 949, pass 949, fail 0, cancelled 0, skipped 0, todo 0. The final run for
this branch is recorded in [Final checks](#final-checks).

## Standalone live smoke

One run of `scripts/live/claude-report-only/e2e-compaction.mjs` against the guarded
disposable fixture. It was a native workflow start with `runtime.snapshot: false`,
**not** a coordinator-managed run.

| Step | Observed |
| --- | --- |
| Fingerprints | Candidate build digest = digest of the plugin copy the fixture loaded = digest in the run state = digest in the receipt: `2e1940c00701c9c8c279abf8d32e1f7bb8529c735f4eb85882871af43efc884f`; protocol `structured-v1` |
| Compaction | Requested once for the executor child through the supported `POST /api/session/:id/compact` route after its first completed non-submission tool call (5 had completed); one compaction message reached `completed`; none failed or stayed running |
| Dispatch prompt | Present in the archive (25 messages: 22 assistant, 1 user, 1 compaction, 1 idle); absent from the active context at submission (20 messages) and afterwards (22 messages) |
| Submission | Carrier is the submission call, and the nearest earlier user message is the dispatch prompt; a completed compaction lies between prompt and carrier; 21 child tool calls followed the compaction request |
| Receipt and acknowledgement | Receipt absent before the call; the post-hook saw the durable receipt, and the receipt existed and was accepted before the acknowledgement |
| Native stop | Final assistant `finish: stop`, newest archive entry `idle`, outcome captured after the receipt, no active session left |
| Advancement | Checkpoint index moved 0 → 1 exactly once; one result |
| Cursor probe | At page size 2 the walk took 13 pages and equals the single-page archive; `cursor.next` leads toward older messages in descending order |
| Provenance denial / human pause | None |

### Format correction

The executor made **two** submission calls: the first was rejected as a repairable
`format` error (three `missing_gate` errors at the evidence path, omitted gates), the
second was accepted. The observed correction count is **1**, not zero. The earlier
harness check `noRepair` read the run state's repair counter, which is cleared after
acceptance, so it was not evidence of zero corrections; it has been removed. The
`reportCorrections` value in the recorded result is 0; it is not used as evidence of
the format-correction count.

### Harness verdict (corrected)

`scripts/live/claude-report-only/compaction-verdict.mjs` holds the verdict rules, used
by `e2e-compaction.mjs`:

- `formatCorrections` is counted from the observed submission calls (repairable
  `format` rejections before the accepted call), never from the run state.
- A new check, `formatCorrectionsWithinLimit`, requires at most two corrections, the
  documented repair limit.
- The run passes only with at least one check, every check true, no failure while
  waiting for the workflow and no compaction request error; otherwise the script sets
  `process.exitCode = 1`. Before, failed evidence still exited 0.
- Every other evidence check is unchanged.

Evaluated read-only on the retained summary of the smoke (nothing written): 1 format
correction, the remaining 20 checks and the new limit check all true, no wait failure,
no compaction error: pass. The retained file itself still contains the old
`noRepair` entry.

## Coordinator admission

Read-only query (`file:...?mode=ro` URI) of the coordinator database for the run that
finished this feature, plus the run-owned runtime copy beside its checkout:

| Field | Value |
| --- | --- |
| Checkpoint `protocol` | `structured-v1` |
| Checkpoint `runtime.build.digest` | `2e1940c00701c9c8c279abf8d32e1f7bb8529c735f4eb85882871af43efc884f` (equal to the standalone smoke digest) |
| Checkpoint `runtime.build.snapshot` | `1` (true) |
| Run-owned copy | `runtime/.heimdall-runtime-snapshot.json` present; its identity digest equals the digest above |

This shows the finishing run was admitted by the coordinator with that build and a
run-owned snapshot. It is not a compaction test: it does not show a coordinator-managed
child being compacted, and it is distinct from the standalone smoke above, which had no
snapshot. Nothing was edited.

## Isolation

- Guarded disposable fixture under `/private/tmp/heimdall-0008.XXXXXX` (confinement
  check: guard files present, writes outside the fixture root and to the guard
  directory denied, the `security` binary denied, cleanup confirmed). The server,
  profile, data, cache, state and provider stores live under the fixture root.
- Credentials were reached only through a read-only Keychain broker that does not
  expose refresh tokens. No credential was copied, refreshed, printed or written.
- Quota was injected through the documented fixture seam (`createPlugin({ quota })`);
  real quota behavior was not tested.
- The harness writes no receipt, checkpoint or outcome; it only reads, besides the ADR
  commit in the fixture repository and the compaction request.

Versions recorded in the fixture manifest: OpenCode 2.0.22, provider
`@openchamber/opencode-claude` 1.3.4, `@anthropic-ai/claude-agent-sdk` 0.3.224,
Node v22.22.3. The manifest holds package versions only; no CLI version was probed.

## Commands

Prepare the fixture and start the server only through the guard, as for
`e2e-structured.mjs` (see [structured-completion-live.md](structured-completion-live.md)),
then:

```sh
node scripts/live/claude-report-only/e2e-compaction.mjs \
  --root /private/tmp/heimdall-0008.XXXXXX --expect-digest <sha256>
```

It writes `evidence/e2e-compaction.jsonl` (timeline) and `evidence/e2e-compaction.json`
(summary) under the fixture root and now exits non-zero when the evidence fails.
Focused automated checks:

```sh
npm run build
node --test test/live-harness.test.mjs test/observer.test.mjs test/native-composition.test.mjs
```

## Cleanup

- The Keychain broker started for the smoke is no longer running (a read-only process
  lookup made when this record was written found no such process). No stop timestamp
  was recorded for it.
- The fixture root stays on disk outside the repository with its evidence and holds no
  committed material. Remove it with the usual `rm -rf` when it is no longer needed.
- `HOME` was not modified.

## Final checks

<!-- PENDING: to be filled by the final verification task with the actual commands,
exit codes and totals for `npm run check`, `npm test` and `npm run build:extension`
on Node v22.22.3. Until then no final result is claimed. -->

## Not proven and remaining limits

- **Coordinator-managed compaction.** Compaction was exercised only in the standalone
  smoke. No coordinator-managed child was compacted live.
- **Real quota.** Quota was injected; quota behavior on the real provider was not
  tested.
- **One run.** A single smoke on `claude-code` with one compaction; several
  compactions and compaction during a restart are covered by unit tests only.
- **Format repair beyond one correction.** One repairable format rejection followed by
  an accepted call was observed; the exhausted-repair and pause paths remain unit
  tested only.
- **Verdict on the retained run.** The corrected verdict was evaluated on the retained
  summary but the live script was not rerun after the change.
- **Installed build.** Nothing was installed, activated, restarted, merged or pushed.
  A running instance keeps the build it was admitted with.
- The limits of the earlier live records still apply: access token only (a token that
  expires mid-run fails authentication), and the guard denies writes without hiding
  credentials from reads or restricting the network.
