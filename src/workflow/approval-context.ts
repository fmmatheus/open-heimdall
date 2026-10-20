/**
 * The owner decision the coordinator hands to a resumed task, as one versioned JSON envelope.
 *
 * The coordinator renders it (never an agent or a client), stores it as the run's resolution and delivers it through the
 * ordinary resume path. The runner recognizes it only for a coordinator-managed run, keeps it in the checkpoint until the
 * task really advances, and turns it into an explicit block of the child prompt. Any other resolution text keeps today's
 * free-text behavior.
 */
export const APPROVAL_CONTINUATION = 'approval-continuation';
export const APPROVAL_CONTINUATION_VERSION = 1;

export interface ApprovalContext {
  heimdall: typeof APPROVAL_CONTINUATION;
  version: typeof APPROVAL_CONTINUATION_VERSION;
  requestId: string;
  decision: 'approve' | 'request-changes';
  /** The owner's feedback, verbatim; null when approving. */
  feedback: string | null;
  /** Exactly what an approval authorizes, as the agent asked for it. */
  scope: string;
  /** The reviewed state the decision applies to. */
  revision: { head: string; digest: string };
  /** The actions the agent keeps after an approval / after requested changes. */
  onApprove: string[];
  onRequestChanges: string[];
  taskId: string;
  index: number;
  /** Present when the reviewed material changed before dispatch: the decision no longer authorizes anything. */
  superseded?: { reason: string };
}

const KEYS = new Set(['heimdall', 'version', 'requestId', 'decision', 'feedback', 'scope', 'revision', 'onApprove', 'onRequestChanges', 'taskId', 'index', 'superseded']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');

export function renderApprovalContext(context: Omit<ApprovalContext, 'heimdall' | 'version'>): string {
  const rendered: ApprovalContext = {
    heimdall: APPROVAL_CONTINUATION, version: APPROVAL_CONTINUATION_VERSION, requestId: context.requestId, decision: context.decision,
    feedback: context.feedback, scope: context.scope, revision: { head: context.revision.head, digest: context.revision.digest },
    onApprove: [...context.onApprove], onRequestChanges: [...context.onRequestChanges], taskId: context.taskId, index: context.index,
    ...(context.superseded ? { superseded: { reason: context.superseded.reason } } : {}),
  };
  return JSON.stringify(rendered);
}

/** The same decision with its authorization withdrawn. The agent keeps its work and must ask again. */
export function supersedeApprovalContext(context: ApprovalContext, reason: string): string {
  const { heimdall: _heimdall, version: _version, ...rest } = context;
  return renderApprovalContext({ ...rest, superseded: { reason } });
}

/**
 * Undefined for any text that is not an approval envelope. Text that claims to be one but is malformed throws, so a
 * damaged decision is never silently delivered as free text.
 */
export function parseApprovalContext(text: string | undefined): ApprovalContext | undefined {
  if (typeof text !== 'string' || !text.startsWith('{')) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!record(value) || value.heimdall !== APPROVAL_CONTINUATION) return undefined;
  const { revision, superseded } = value;
  const valid = value.version === APPROVAL_CONTINUATION_VERSION && Object.keys(value).every(key => KEYS.has(key))
    && typeof value.requestId === 'string' && value.requestId !== '' && (value.decision === 'approve' || value.decision === 'request-changes')
    && (value.decision === 'approve' ? value.feedback === null : typeof value.feedback === 'string' && value.feedback.trim() !== '')
    && typeof value.scope === 'string' && record(revision) && typeof revision.head === 'string' && typeof revision.digest === 'string'
    && strings(value.onApprove) && strings(value.onRequestChanges) && typeof value.taskId === 'string' && value.taskId !== ''
    && Number.isSafeInteger(value.index) && (value.index as number) >= 0
    && (superseded === undefined || (record(superseded) && typeof superseded.reason === 'string' && Object.keys(superseded).length === 1));
  if (!valid) throw new Error('Malformed approval continuation');
  return value as unknown as ApprovalContext;
}

const list = (entries: string[]) => entries.length ? entries.map(entry => '  - ' + entry).join('\n') : '  - (none stated)';

/** The explicit block of the child prompt. Feedback is quoted verbatim between fixed markers. */
export function approvalPromptBlock(context: ApprovalContext): string {
  const lines = [
    'Owner decision on your approval request ' + context.requestId + ' (task ' + context.taskId + '):',
    'Decision: ' + (context.superseded ? 'SUPERSEDED - the owner decision no longer applies' : context.decision),
    'Scope you asked approval for: ' + context.scope,
    'Reviewed revision: commit ' + context.revision.head + ', content digest ' + context.revision.digest,
  ];
  if (context.superseded) {
    lines.push(
      'The reviewed material changed after the owner answered (' + context.superseded.reason + '), so nothing is authorized. Keep your work, do NOT perform the gated action, and submit a fresh approval request for the material as it stands now.',
      'Original owner decision: ' + context.decision,
      ...(context.feedback === null ? [] : ['Owner feedback (verbatim, between the markers):', '<<<OWNER FEEDBACK', context.feedback, 'OWNER FEEDBACK>>>']),
    );
  } else if (context.decision === 'approve') {
    lines.push('The owner approved exactly that scope and nothing else. You keep every remaining action yourself:', list(context.onApprove));
  } else {
    lines.push(
      'The owner requested changes. Do NOT perform the gated action. Correct the work within the task scope, then submit a fresh approval request; this request cannot be approved any more.',
      'Owner feedback (verbatim, between the markers):', '<<<OWNER FEEDBACK', context.feedback ?? '', 'OWNER FEEDBACK>>>',
      'You keep these actions:', list(context.onRequestChanges),
    );
  }
  lines.push('An approval does not complete any gate: complete the task only with an ordinary evidence-backed completed submission. If you change the reviewed material, request fresh approval.');
  return lines.join('\n');
}
