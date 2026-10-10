import { createHash } from 'node:crypto';

/**
 * Strict, versioned submission contracts for the structured protocol.
 *
 * Each submission kind is defined once, as data (`plannerPlanContract`, `executorResultContract`). The
 * TypeScript types, the runtime validator, the tool input schema and the tool description are all derived
 * from that single definition, so they cannot drift apart. Payloads never carry authoritative identity:
 * the host derives run, task, attempt, phase and session identity from its own durable state.
 */

export const SUBMISSION_PROTOCOL = 'structured-v1';
export const SUBMISSION_KINDS = ['planner-plan', 'executor-result'] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/** Exact registered tool ids. Matching is always by equality, never by suffix. */
export const SUBMISSION_TOOL_IDS: Readonly<Record<SubmissionKind, string>> = Object.freeze({
  'planner-plan': 'heimdall_submit_plan',
  'executor-result': 'heimdall_submit_result',
});
export const submissionKindOfTool = (name: string): SubmissionKind | undefined =>
  SUBMISSION_KINDS.find(kind => SUBMISSION_TOOL_IDS[kind] === name);
/** True for a name that ends with a submission tool id but is not that id (namespaced or otherwise decorated). */
export const isLookalikeSubmissionTool = (name: string): boolean =>
  !submissionKindOfTool(name) && Object.values(SUBMISSION_TOOL_IDS).some(id => name.endsWith(id));

/** Fields a model must never supply: the host derives identity from durable state and the native call context. */
export const IDENTITY_FIELDS: readonly string[] = Object.freeze(['runId', 'taskId', 'attemptId', 'phase', 'parent', 'child', 'owner', 'build']);

export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const GATE_ID_PATTERN = /^G([1-9][0-9]*)$/;
/** Shared with the legacy plan validator so both paths agree on what a task id is. */
export const isTaskId = (id: unknown): boolean => TASK_ID_PATTERN.test(id as string);

export type ContractErrorCode =
  | 'invalid_type' | 'missing_field' | 'unknown_field' | 'identity_field' | 'empty_string' | 'invalid_value'
  | 'empty_array' | 'invalid_task_id' | 'duplicate_task_id' | 'invalid_dependency' | 'task_limit'
  | 'invalid_gate_id' | 'duplicate_gate_id' | 'gate_out_of_range' | 'missing_gate' | 'too_many_errors';

export interface ContractError {
  /** `$` is the payload root, then `.field` and `[index]` segments. */
  path: string;
  code: ContractErrorCode;
  message: string;
}

// --- Single-source definition language -------------------------------------------------------------------

interface Described { readonly description?: string }
interface LiteralSpec<V extends string | true = string | true> extends Described { readonly type: 'literal'; readonly value: V }
interface TextSpec extends Described { readonly type: 'text' }
interface TaskIdSpec extends Described { readonly type: 'taskId' }
interface GateIdSpec extends Described { readonly type: 'gateId' }
interface FlagSpec extends Described { readonly type: 'flag' }
interface ListSpec<I extends Spec = Spec> extends Described { readonly type: 'list'; readonly item: I; readonly min: number }
interface ObjectSpec<F extends { readonly [key: string]: Spec } = { readonly [key: string]: Spec }> extends Described { readonly type: 'object'; readonly fields: F }
type Spec = LiteralSpec | TextSpec | TaskIdSpec | GateIdSpec | FlagSpec | ListSpec | ObjectSpec;

type Infer<S> =
  S extends LiteralSpec<infer V> ? V
  : S extends TextSpec | TaskIdSpec | GateIdSpec ? string
  : S extends FlagSpec ? boolean
  : S extends ListSpec<infer I> ? Infer<I>[]
  : S extends ObjectSpec<infer F> ? { -readonly [K in keyof F]: Infer<F[K]> }
  : never;

const literal = <const V extends string | true>(value: V, description?: string): LiteralSpec<V> => ({ type: 'literal', value, description });
const text = (description: string): TextSpec => ({ type: 'text', description });
const taskId = (description: string): TaskIdSpec => ({ type: 'taskId', description });
const gateId = (description: string): GateIdSpec => ({ type: 'gateId', description });
const flag = (description: string): FlagSpec => ({ type: 'flag', description });
const list = <const I extends Spec>(item: I, min: number, description: string): ListSpec<I> => ({ type: 'list', item, min, description });
const object = <const F extends { readonly [key: string]: Spec }>(fields: F, description?: string): ObjectSpec<F> => ({ type: 'object', fields, description });

const taskSpec = object({
  id: taskId('Unique task id'),
  title: text('Short task title'),
  brief: text('Full task brief'),
  dependsOn: list(taskId('Id of an earlier task'), 0, 'Ids of earlier tasks this task depends on; use [] for none'),
  dod: list(text('One verifiable acceptance gate'), 1, 'Acceptance gates; the executor reports one evidence entry per gate'),
}, 'One planned task');

const plannerVariants = {
  artifacts: object({
    status: literal('planned', 'Plan outcome'),
    artifacts: literal(true, 'The plan was written to the fixed host-owned planning directory; the host reads it from there'),
  }),
  inline: object({
    status: literal('planned', 'Plan outcome'),
    planMarkdown: text('The complete plan document'),
    factSheet: text('The fact sheet'),
    tasks: list(taskSpec, 1, 'Ordered tasks; each may depend only on earlier tasks'),
  }),
  blocked: object({
    status: literal('blocked', 'Blocked outcome'),
    reason: text('Specific blocker and the owner steps that resolve it'),
  }),
} as const;

const executorVariants = {
  completed: object({
    status: literal('completed', 'Completed outcome'),
    summary: text('What changed'),
    handoff: text('What the next task must know'),
    evidence: list(object({
      gateId: gateId('Stable gate id G1..Gn matching the task gate list'),
      passed: flag('true only when the gate was fully proved'),
      detail: text('The actual check, result and evidence location'),
    }), 1, 'Exactly one entry for every gate of the task'),
  }),
  blocked: object({
    status: literal('blocked', 'Blocked outcome'),
    reason: text('Specific blocker and the owner steps that resolve it'),
  }),
} as const;

export type PlannerPlan = Infer<(typeof plannerVariants)[keyof typeof plannerVariants]>;
export type ExecutorResult = Infer<(typeof executorVariants)[keyof typeof executorVariants]>;
export type PlannedTask = Infer<typeof taskSpec>;
export type PlannerOutcome = 'planned' | 'blocked';
export type ExecutorOutcome = 'completed' | 'blocked' | 'unfinished';

export interface ContractRef {
  protocol: typeof SUBMISSION_PROTOCOL;
  kind: SubmissionKind;
  version: number;
}

/**
 * `format` errors are repairable: the payload was malformed. A structurally valid payload is never a format
 * error: a blocked outcome or an unpassed gate is a semantic result that must never be offered for repair.
 */
export type ContractResult<T, O extends string> =
  | { ok: true; contract: ContractRef; variant: string; value: T; outcome: O; classification: 'accepted' | 'semantic'; repairable: false; digest: string }
  | { ok: false; contract: ContractRef; classification: 'format'; repairable: true; errors: ContractError[] };

interface ContractDefinition<Variants extends { readonly [name: string]: ObjectSpec }, Context> {
  readonly kind: SubmissionKind;
  readonly version: number;
  readonly variants: Variants;
  /** Variant per accepted `status` value; the key set is the accepted status list. */
  readonly select: { readonly [status: string]: (payload: Record<string, unknown>) => keyof Variants & string };
  readonly refine: (variant: keyof Variants & string, value: never, context: Context, report: Reporter) => void;
  readonly outcome: (variant: keyof Variants & string, value: never) => string;
}
type Reporter = (path: string, code: ContractErrorCode, message: string) => void;

export const plannerPlanContract: ContractDefinition<typeof plannerVariants, { limit: number }> = {
  kind: 'planner-plan',
  version: 1,
  variants: plannerVariants,
  select: { planned: payload => 'artifacts' in payload ? 'artifacts' : 'inline', blocked: () => 'blocked' },
  refine(variant, value, context, report) {
    if (variant !== 'inline') return;
    const { tasks } = value as Infer<(typeof plannerVariants)['inline']>;
    if (tasks.length > context.limit) report('$.tasks', 'task_limit', `Plan has ${tasks.length} tasks; maximum is ${context.limit}. Consolidate tasks without dropping scope or acceptance gates.`);
    const seen = new Set<string>();
    tasks.forEach((task, index) => {
      if (seen.has(task.id)) report(`$.tasks[${index}].id`, 'duplicate_task_id', `Task id ${JSON.stringify(task.id)} is used more than once`);
      task.dependsOn.forEach((dependency, at) => {
        if (!seen.has(dependency)) report(`$.tasks[${index}].dependsOn[${at}]`, 'invalid_dependency', `Dependency ${JSON.stringify(dependency)} is not a task listed earlier in tasks`);
      });
      seen.add(task.id);
    });
  },
  outcome: variant => variant === 'blocked' ? 'blocked' : 'planned',
};

export const executorResultContract: ContractDefinition<typeof executorVariants, { dodCount: number }> = {
  kind: 'executor-result',
  version: 1,
  variants: executorVariants,
  select: { completed: () => 'completed', blocked: () => 'blocked' },
  refine(variant, value, context, report) {
    if (variant !== 'completed') return;
    const { evidence } = value as Infer<(typeof executorVariants)['completed']>;
    const covered = new Set<number>();
    evidence.forEach((entry, index) => {
      const gate = GATE_ID_PATTERN.exec(entry.gateId);
      const gateIndex = gate ? Number(gate[1]) - 1 : -1;
      if (gateIndex < 0) return;
      if (gateIndex >= context.dodCount) report(`$.evidence[${index}].gateId`, 'gate_out_of_range', `Gate ${entry.gateId} does not exist; this task has gates G1..G${context.dodCount}`);
      else if (covered.has(gateIndex)) report(`$.evidence[${index}].gateId`, 'duplicate_gate_id', `Gate ${entry.gateId} has more than one evidence entry`);
      else covered.add(gateIndex);
    });
    for (let index = 0; index < context.dodCount; index++) {
      if (!covered.has(index)) report('$.evidence', 'missing_gate', `No evidence entry for gate G${index + 1}`);
    }
  },
  outcome: (variant, value) => {
    if (variant === 'blocked') return 'blocked';
    return (value as Infer<(typeof executorVariants)['completed']>).evidence.every(entry => entry.passed === true) ? 'completed' : 'unfinished';
  },
};

type AnyDefinition = ContractDefinition<{ readonly [name: string]: ObjectSpec }, never>;
const definitions: Readonly<Record<SubmissionKind, AnyDefinition>> = {
  'planner-plan': plannerPlanContract as unknown as AnyDefinition,
  'executor-result': executorResultContract as unknown as AnyDefinition,
};

/** What the host knows about the bound attempt; never taken from the payload. */
export type SubmissionRule = { kind: 'planner-plan'; limit: number } | { kind: 'executor-result'; dodCount: number };
export const contractRef = (kind: SubmissionKind): ContractRef => ({ protocol: SUBMISSION_PROTOCOL, kind, version: definitions[kind].version });

// --- Derived views: field lists, tool schema, tool description -------------------------------------------

/** Every payload field name across all variants of a kind, in definition order. */
export function contractFieldNames(kind: SubmissionKind): string[] {
  const names: string[] = [];
  for (const variant of Object.values(definitions[kind].variants)) for (const name of Object.keys(variant.fields)) if (!names.includes(name)) names.push(name);
  return names;
}

function describeSpec(spec: Spec): string {
  switch (spec.type) {
    case 'literal': return JSON.stringify(spec.value);
    case 'text': return 'non-empty string';
    case 'taskId': return 'task id string matching [A-Za-z0-9_-]+';
    case 'gateId': return 'gate id string "G<n>"';
    case 'flag': return 'boolean';
    case 'list': return `${spec.min > 0 ? 'non-empty ' : ''}array of ${describeSpec(spec.item)}`;
    case 'object': return '{ ' + Object.entries(spec.fields).map(([name, field]) => `${name}: ${describeSpec(field)}`).join(', ') + ' }';
  }
}

/**
 * Tool input schema derived from the contract. The transport schema is deliberately permissive (no types,
 * nothing required, unknown properties allowed) so every call reaches Heimdall's own validator and gets
 * precise path-specific feedback; the host always validates explicitly.
 */
export function submissionInputSchema(kind: SubmissionKind): { type: 'object'; properties: Record<string, { description: string }>; additionalProperties: true } {
  const gathered = new Map<string, string[]>();
  for (const variant of Object.values(definitions[kind].variants)) {
    for (const [name, spec] of Object.entries(variant.fields)) {
      const notes = gathered.get(name) ?? [];
      const note = spec.type === 'literal' ? `${describeSpec(spec)}` : `${describeSpec(spec)}${spec.description ? ': ' + spec.description : ''}`;
      if (!notes.includes(note)) notes.push(note);
      gathered.set(name, notes);
    }
  }
  const properties: Record<string, { description: string }> = {};
  for (const [name, notes] of gathered) properties[name] = { description: notes.join(' | ') };
  return { type: 'object', properties, additionalProperties: true };
}

export function submissionToolDescription(kind: SubmissionKind): string {
  const variants = Object.entries(definitions[kind].variants).map(([name, variant]) =>
    `- ${name}: ` + Object.entries(variant.fields).map(([field, spec]) => `${field} (${describeSpec(spec)})`).join(', '));
  const subject = kind === 'planner-plan' ? 'your plan' : 'your final completion report';
  return [
    `Submit ${subject} as structured input (${SUBMISSION_PROTOCOL}, ${kind} v${definitions[kind].version}). This is the only way to report; prose and code fences are never read.`,
    'Pass exactly one of these shapes as the tool arguments:',
    ...variants,
    `Do not send identity (${IDENTITY_FIELDS.join(', ')}): the host derives it. Unknown or missing fields are rejected with the exact path.`,
  ].join('\n');
}

// --- Strict validation engine ----------------------------------------------------------------------------

const MAX_ERRORS = 50;
const typeName = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
};
const preview = (value: unknown): string => {
  const rendered = typeof value === 'string' ? JSON.stringify(value) : typeName(value);
  return rendered.length > 40 ? rendered.slice(0, 37) + '...' : rendered;
};

class Collector {
  readonly errors: ContractError[] = [];
  private truncated = false;
  readonly report: Reporter = (path, code, message) => {
    if (this.errors.length < MAX_ERRORS) this.errors.push({ path, code, message });
    else this.truncated = true;
  };
  finish(): ContractError[] {
    if (this.truncated) this.errors.push({ path: '$', code: 'too_many_errors', message: `More than ${MAX_ERRORS} errors; fix these first and resubmit` });
    return this.errors;
  }
}

/** Validates without mutating `raw`; returns a freshly built value containing only specified fields. */
function validateSpec(raw: unknown, spec: Spec, path: string, report: Reporter, root: boolean): unknown {
  switch (spec.type) {
    case 'literal':
      if (raw !== spec.value) report(path, raw === undefined ? 'missing_field' : 'invalid_value', `Expected ${JSON.stringify(spec.value)}, received ${preview(raw)}`);
      return spec.value;
    case 'text':
    case 'taskId':
    case 'gateId': {
      if (typeof raw !== 'string') { report(path, 'invalid_type', `Expected a string, received ${typeName(raw)}`); return undefined; }
      if (!raw.trim()) { report(path, spec.type === 'text' ? 'empty_string' : spec.type === 'taskId' ? 'invalid_task_id' : 'invalid_gate_id', 'Must not be empty or whitespace'); return undefined; }
      if (spec.type === 'taskId' && !TASK_ID_PATTERN.test(raw)) report(path, 'invalid_task_id', `Task id ${preview(raw)} must match ${TASK_ID_PATTERN.source}`);
      if (spec.type === 'gateId' && !GATE_ID_PATTERN.test(raw)) report(path, 'invalid_gate_id', `Gate id ${preview(raw)} must look like G1, G2, ... with no leading zeros`);
      return raw;
    }
    case 'flag':
      if (typeof raw !== 'boolean') { report(path, 'invalid_type', `Expected a boolean, received ${typeName(raw)}`); return undefined; }
      return raw;
    case 'list': {
      if (!Array.isArray(raw)) { report(path, 'invalid_type', `Expected an array, received ${typeName(raw)}`); return undefined; }
      if (raw.length < spec.min) report(path, 'empty_array', spec.min === 1 ? 'Must contain at least one entry' : `Must contain at least ${spec.min} entries`);
      const items: unknown[] = [];
      for (let index = 0; index < raw.length; index++) items.push(validateSpec(raw[index], spec.item, `${path}[${index}]`, report, false));
      return items;
    }
    case 'object': {
      if (!isPlainObject(raw)) { report(path, 'invalid_type', `Expected a JSON object, received ${typeName(raw)}${typeof raw === 'string' ? '; the host never parses prose or code fences' : ''}`); return undefined; }
      const built: Record<string, unknown> = {};
      for (const key of Object.keys(raw)) {
        if (Object.hasOwn(spec.fields, key)) continue;
        if (root && IDENTITY_FIELDS.includes(key)) report(`${path}.${key}`, 'identity_field', `Field "${key}" is identity and is derived by the host; remove it`);
        else report(`${path}.${key}`, 'unknown_field', `Unknown field "${key}"; allowed fields: ${Object.keys(spec.fields).join(', ')}`);
      }
      for (const [key, field] of Object.entries(spec.fields)) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (!descriptor || (('value' in descriptor) && descriptor.value === undefined)) { report(`${path}.${key}`, 'missing_field', `Missing required field "${key}"`); continue; }
        if (!('value' in descriptor)) { report(`${path}.${key}`, 'invalid_type', 'Must be a plain data property'); continue; }
        built[key] = validateSpec(descriptor.value, field, `${path}.${key}`, report, false);
      }
      return built;
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function contractDigest(ref: ContractRef, value: unknown): string {
  return createHash('sha256').update(JSON.stringify({ protocol: ref.protocol, kind: ref.kind, version: ref.version, value })).digest('hex');
}

/** Validates one raw submission against the contract for `rule.kind`. Never mutates, repairs or guesses `raw`. */
export function validateSubmission(rule: SubmissionRule, raw: unknown): ContractResult<PlannerPlan | ExecutorResult, PlannerOutcome | ExecutorOutcome> {
  const definition = definitions[rule.kind];
  const contract = contractRef(rule.kind);
  const collector = new Collector();
  const fail = (): ContractResult<never, never> => ({ ok: false, contract, classification: 'format', repairable: true, errors: collector.finish() });
  if (!isPlainObject(raw)) {
    collector.report('$', 'invalid_type', `Expected a JSON object, received ${typeName(raw)}${typeof raw === 'string' ? '; the host never parses prose or code fences' : ''}`);
    return fail();
  }
  const statuses = Object.keys(definition.select);
  const status = Object.getOwnPropertyDescriptor(raw, 'status')?.value as unknown;
  const choose = typeof status === 'string' && Object.hasOwn(definition.select, status) ? definition.select[status] : undefined;
  if (!choose) {
    collector.report('$.status', status === undefined ? 'missing_field' : 'invalid_value', `Expected status to be one of ${statuses.map(s => JSON.stringify(s)).join(', ')}, received ${preview(status)}`);
    for (const key of Object.keys(raw)) if (IDENTITY_FIELDS.includes(key)) collector.report(`$.${key}`, 'identity_field', `Field "${key}" is identity and is derived by the host; remove it`);
    return fail();
  }
  const variant = choose(raw);
  const value = validateSpec(raw, definition.variants[variant]!, '$', collector.report, true);
  if (!collector.errors.length) definition.refine(variant, value as never, (rule.kind === 'planner-plan' ? { limit: rule.limit } : { dodCount: rule.dodCount }) as never, collector.report);
  if (collector.errors.length) return fail();
  const canonical = deepFreeze(value) as PlannerPlan | ExecutorResult;
  const outcome = definition.outcome(variant, canonical as never) as PlannerOutcome | ExecutorOutcome;
  return {
    ok: true, contract, variant, value: canonical, outcome,
    classification: outcome === 'planned' || outcome === 'completed' ? 'accepted' : 'semantic',
    repairable: false, digest: contractDigest(contract, canonical),
  };
}

export const validatePlannerPlan = (raw: unknown, context: { limit: number }) => validateSubmission({ kind: 'planner-plan', ...context }, raw);
export const validateExecutorResult = (raw: unknown, context: { dodCount: number }) => validateSubmission({ kind: 'executor-result', ...context }, raw);
