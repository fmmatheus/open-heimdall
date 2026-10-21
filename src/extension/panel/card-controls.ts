import type { ButtonHandle, ButtonProps, TextFieldHandle, TextFieldProps } from '@openchamber/sdk/ui';
import { canRequestChanges, canRespond, waitCard } from './view-model.js';
import type { WaitCardView } from './view-model.js';
import type { PanelState, PanelStore } from './store.js';
import type { RunDetail } from '../shared/protocol.js';

/*
 * The owner's controls on the approval or response card: the response field, Load full request, Approve and continue,
 * Request changes and Respond and continue. They are separate from `main.ts` so a test can mount them against the real
 * panel store with a small stand-in for the SDK components and click the very handlers a user's click reaches. This module
 * touches no global: the SDK mounts and the element factory are passed in.
 */

/** The SDK components the controls are built from. */
export interface ControlsUi {
  mountButton(slot: HTMLElement, props: ButtonProps): ButtonHandle;
  mountTextField(slot: HTMLElement, props: TextFieldProps): TextFieldHandle;
  /** A plain element for layout; `span`, `div` or `p`. */
  element(tag: 'span' | 'div' | 'p'): HTMLElement;
}

/** The store operations the controls call. */
export type ControlsStore = Pick<PanelStore, 'getState' | 'decideApproval' | 'respondToPause' | 'loadApprovalDetails'>;

export interface CardControlsOptions {
  ui: ControlsUi;
  store: ControlsStore;
  /** The run detail the card was drawn from; the controls name this run and this wait, whatever the store holds later. */
  detail: RunDetail;
  /** Drafts typed into cards, by card key. */
  drafts: Map<string, string>;
  /** The element the controls are placed in; hidden while the card has none. */
  container: HTMLElement;
  /** Ask the owner of the card to repaint after the draft changed. */
  repaint(): void;
}

export interface CardControlsHandle {
  /** Update labels, visibility and enabled state from the store state; returns the card view they were derived from. */
  paint(state: PanelState): WaitCardView | null;
  dispose(): void;
}

/** Mounts the controls once for a drawn card; `paint` updates them in place so typing and focus survive a poll. */
export function mountCardControls(options: CardControlsOptions): CardControlsHandle {
  const { ui, store, detail, drafts, container } = options;
  const wait = detail.wait ?? null;
  const first = waitCard(detail, store.getState());
  if (wait === null || first === null) return { paint: () => null, dispose() {} };
  const key = first.key;

  const fieldSlot = ui.element('div');
  fieldSlot.dataset.cardField = 'true';
  const actions = ui.element('div');
  actions.className = 'hm-actions';
  const hint = ui.element('p');
  hint.className = 'hm-meta';
  container.append(fieldSlot, actions, hint);

  const draft = (): string => drafts.get(key) ?? '';
  const field = ui.mountTextField(fieldSlot, {
    label: '', value: draft(), multiline: true, rows: 4,
    onChange: value => { drafts.set(key, value); field.update({ value }); options.repaint(); },
  });
  const slots = { load: ui.element('span'), approve: ui.element('span'), changes: ui.element('span'), respond: ui.element('span') };
  actions.append(slots.load, slots.approve, slots.changes, slots.respond);
  const finished = (outcome: Promise<string>): void => { void outcome.then(result => { if (result === 'recorded') { drafts.delete(key); field.update({ value: '' }); } }); };

  const load = ui.mountButton(slots.load, {
    label: 'Load full request', variant: 'secondary', size: 'sm',
    onClick: () => { if (wait.kind === 'approval') store.loadApprovalDetails(detail.id, wait.requestId); },
  });
  const approve = ui.mountButton(slots.approve, {
    label: 'Approve and continue', variant: 'default', size: 'sm',
    onClick: () => { if (wait.kind === 'approval') finished(store.decideApproval(detail.id, wait.requestId, 'approve')); },
  });
  const changes = ui.mountButton(slots.changes, {
    label: 'Request changes', variant: 'outline', size: 'sm',
    onClick: () => { if (wait.kind === 'approval') finished(store.decideApproval(detail.id, wait.requestId, 'request-changes', draft())); },
  });
  const respond = ui.mountButton(slots.respond, {
    label: 'Respond and continue', variant: 'default', size: 'sm',
    onClick: () => { if (wait.kind === 'generic') finished(store.respondToPause(detail.id, wait.pauseId, draft())); },
  });

  return {
    paint(state) {
      const view = waitCard(detail, state);
      if (view === null) return null;
      const controls = view.controls;
      container.hidden = controls === null;
      if (controls === null) return view;
      const decide = controls.kind === 'decide';
      slots.load.hidden = !decide || view.fullRequest === null;
      slots.approve.hidden = !decide;
      slots.changes.hidden = !decide;
      slots.respond.hidden = decide;
      field.update({ label: decide ? controls.feedbackLabel : controls.inputLabel, disabled: view.inFlight, value: draft() });
      hint.textContent = decide ? controls.feedbackHint : controls.inputHint;
      if (decide) {
        if (view.fullRequest !== null) load.update({ label: view.fullRequest.label, disabled: view.fullRequest.disabled });
        approve.update({ label: controls.approve.label, disabled: controls.approve.disabled });
        changes.update({ label: controls.requestChanges.label, disabled: controls.requestChanges.disabled || !canRequestChanges(draft()) });
      } else {
        respond.update({ label: controls.respond.label, disabled: controls.respond.disabled || !canRespond(draft()) });
      }
      return view;
    },
    dispose() {
      for (const handle of [field, load, approve, changes, respond]) handle.dispose();
    },
  };
}
