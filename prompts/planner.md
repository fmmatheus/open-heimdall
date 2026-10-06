Read the supplied ADR and create incremental tasks executable in separate fresh
sessions. Reuse confirmed facts so executors do not repeat discovery.

Plan at most 10 tasks, including final integrated verification. Count the array
before finishing. Consolidate related tasks without dropping scope or acceptance
gates. If that cannot be done responsibly, return blocked with the scope tradeoff.

Read relevant repository instructions and existing plans or verification records.
Do not implement work, run broad tests, or change repository configuration while
planning. Write only inside the supplied planning artifact directory.

Create a compact fact sheet with source paths, [CODE-CONFIRMED] facts and
[HYPOTHESIS] items. Distinguish delivered work from remaining ADR scope.
Each task must include its goal, explicit scope and exclusions, exact sections to
read, dependencies, deliverables, focused checks, and evidence-based definition
of done (DoD). Tasks execute in array order; dependencies refer only to earlier
tasks. Keep each task small enough for one session. Self-review, tests and required
verification belong in that task's DoD; do not add separate reviewer agents.

Respect the supplied branch and commit conventions. Never plan to overwrite or
commit pre-existing edits. Return blocked if overlapping edits prevent safe work.
Put any necessary owner decision or manual verification at the relevant task's
last step, with precise instructions. Automated checks cannot replace explicitly
required runtime or owner evidence. Avoid repeating checks unless affected work
changes or earlier evidence is invalidated.

Write these files in the supplied planning artifact directory:
- plan.md: concise plan and global constraints; reference task briefs.
- facts.md: confirmed facts, source paths and uncertainties.
- tasks.md: valid JSON array without fences, using this object shape:
  {"id":"T1","title":"title","brief":"self-contained task instructions","dependsOn":[],"dod":["specific acceptance gate"]}

Write in small chunks. Reuse saved artifacts during recovery. Check that tasks.md
parses as JSON and contains every planned task. All task strings must be nonempty;
IDs contain only letters, digits, underscores or hyphens. An empty task list is
invalid; return blocked and explain if the ADR is already delivered.

Use only available research or documentation tools relevant to the ADR. Repository
skills may help planning, but this workflow's artifact paths, task limit, scope and
response contract take precedence over their default execution workflow. Do not
delegate, implement tasks, install missing tools or create a branch-finishing step.
Report unavailable tools as limitations and use available source-reading tools.

Your final reply must be only one small JSON object:
{"status":"planned","artifacts":true}
or {"status":"blocked","reason":"specific decision or prerequisite"}.
Never embed the plan, fact sheet or task briefs in the final response.
