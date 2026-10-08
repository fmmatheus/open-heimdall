# Claude Code coordinator smoke

Validated on 2026-10-07 with OpenCode 2.0.22, the OpenChamber Claude Code
provider 1.3.4, and Claude Agent SDK 0.3.224. Execution used the existing Claude
Code login through that provider, without importing tokens into OpenCode.
The test used disposable Git projects, private coordinator/native databases,
and a copied provider with transcript persistence and user hooks disabled.
Existing workflows and installed provider code were preserved.

Four feature runs planned and completed two ordered tasks each. Global capacity
was two runs; Alpha allowed two and Beta one. Planning used `claude-code/opus`;
quota selection chose `claude-code/sonnet` with `xhigh` effort.

| Run | Observed result |
| --- | --- |
| A1 | Completed T1, paused before T2 edits for owner input, then resumed once in the same parent/worktree/T2 child. T1 files and result were unchanged. |
| A2 | Completed both tasks without recovery. |
| B1 | Rejected malformed T2 JSON. One explicit format-only resume reused its child, preserved the invalid receipt and completed files, and admitted a valid reply. |
| B2 | Reused a saved valid T1 reply after correcting fenced-JSON parsing. T1 was not prompted again; T2 then completed. |

Saved native active responses proved overlapping Alpha execution and at most
one active child per run. Beta stayed queued with spare global capacity while
its project slot was occupied. All four independent project test suites passed;
checkpoint usage matched positive native token counters. Every parent and child
was verified idle before the disposable server stopped.

The original smoke harness retained its failed receipt-count check because B1
needed an extra correction receipt. A separate recovery audit passed with that
receipt explicitly accounted for; prior reports and receipts were preserved.
The successful execution included explicit recovery.

The functional run used the default unlimited usage policy with tracking enabled.
An earlier capped pair paused after reporting 69,374 and 68,652 tokens against
60,000-token planner limits. Reported counts include cache reads; active requests
can exceed a cap before interruption is confirmed. Those runs and worktrees
were retained separately.

The final regression suite passed 173 tests. Protected original workflow source
hashes (85 files) and the installed provider's query implementation were unchanged.
