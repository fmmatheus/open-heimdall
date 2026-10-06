---
description: Resume a paused ADR run with the owner's blocker resolution
agent: adr-orchestrator
subagent: false
---
Resume the workflow. Run ID and owner resolution: $ARGUMENTS
Call adr_workflow action=resume, runId=<the run ID>, input=<the resolution>.
Report the result and wait. Do not infer approval of unresolved acceptance gates.
