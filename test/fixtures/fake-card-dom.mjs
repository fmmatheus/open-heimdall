import { mountCardControls } from '../../dist/extension/panel/card-controls.js';

/*
 * A deterministic stand-in for the SDK components the approval card is built from. The real controls module
 * (`card-controls`) is mounted on it with the real panel store, so a click here runs the same handler a user's click
 * reaches. Like the real button, a disabled or hidden button ignores a click; `forceClick` runs the handler anyway, to show
 * that the store refuses what the buttons would not allow.
 */

class FakeElement {
  constructor(tag) { this.tag = tag; this.hidden = false; this.className = ''; this.dataset = {}; this.children = []; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
}

export function createFakeUi() {
  const buttons = [];
  const fields = [];
  const shown = element => element.hidden !== true;
  const ui = {
    element: tag => new FakeElement(tag),
    mountTextField(slot, props) {
      const handle = {
        props: { ...props },
        update(next) { Object.assign(handle.props, next); },
        dispose() { handle.disposed = true; },
        /** The owner typing into the field. */
        type(value) { handle.props.onChange(value); },
      };
      fields.push(handle);
      return handle;
    },
    mountButton(slot, props) {
      const handle = {
        slot,
        initialLabel: props.label,
        props: { ...props },
        update(next) { Object.assign(handle.props, next); },
        dispose() { handle.disposed = true; },
        /** Visible and enabled, as far as a user can click it. */
        get clickable() { return shown(slot) && handle.props.disabled !== true && handle.props.loading !== true && !handle.disposed; },
        get visible() { return shown(slot); },
        click() { if (!handle.clickable) return false; handle.props.onClick(); return true; },
        forceClick() { handle.props.onClick(); },
      };
      buttons.push(handle);
      return handle;
    },
  };
  return { ui, buttons, fields };
}

/**
 * Draws the card for the store's loaded run detail and keeps it painted, redrawing from scratch whenever the store
 * holds another detail object, as the panel does after each read. Returns the buttons of the card currently on screen.
 */
export function mountCard(store) {
  const drafts = new Map();
  let drawn = null;
  let handle = null;
  let kit = null;
  const draw = () => {
    handle?.dispose();
    const detail = store.getState().detail;
    kit = createFakeUi();
    const container = kit.ui.element('div');
    drawn = detail;
    handle = mountCardControls({ ui: kit.ui, store, detail, drafts, container, repaint: () => handle.paint(store.getState()) });
    handle.paint(store.getState());
    kit.container = container;
  };
  draw();
  const unsubscribe = store.subscribe(state => {
    if (state.detail !== drawn) { if (state.detail?.wait) draw(); return; }
    handle.paint(state);
  });
  const find = label => {
    const found = kit.buttons.find(button => button.initialLabel === label);
    if (!found) throw new Error(`No button ${label}`);
    return found;
  };
  return {
    button: find,
    get field() { return kit.fields[0]; },
    get container() { return kit.container; },
    dispose() { unsubscribe(); handle?.dispose(); },
  };
}
