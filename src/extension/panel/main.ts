import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountProgress,
  mountSelect,
  mountTabs,
} from '@openchamber/sdk/ui';
import { createPanelClient } from './client.js';
import { createNavigation } from './navigation.js';
import type { NavigationView } from './navigation.js';
import { createPanelStore } from './store.js';
import type { PanelState } from './store.js';
import {
  ALL_FILTER,
  bannerInfo,
  blockerInfo,
  currentTaskText,
  detailPlaceholder,
  detailTabs,
  emptyInfo,
  limitRows,
  listNotice,
  modelRows,
  phaseText,
  progressInfo,
  projectFilterOptions,
  runRows,
  statusBadge,
  statusFilterOptions,
  taskRows,
  truncationNotice,
  usageInfo,
  formatAge,
  formatTime,
} from './view-model.js';
import type { Badge, DetailTabId, LabeledRow } from './view-model.js';
import { RUN_STATUSES } from '../shared/protocol.js';
import type { RunDetail, WireRunStatus } from '../shared/protocol.js';

/*
 * Rendering rules for this file:
 *  - Anything that came from a run (labels, tasks, summaries, evidence, reasons, model names, file names) is
 *    written with textContent via `node()` or handed to an SDK component that sets text. Markup is never parsed.
 *  - `mountText` is deliberately not used for run text: it turns `![alt](https://…)` into images and links.
 *  - SDK components are mounted once and updated in place; only the detail body is rebuilt, and only when the
 *    loaded detail, the tab or the selection changes, so a poll does not reset focus or scroll.
 */

function required(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing panel element #${id}`);
  return found;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (className) created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

/** Extension points for later tasks. Each renderer receives the loaded detail and a container to fill. */
export interface DetailExtensions {
  /** T7: "open session" actions, drawn at the end of the Overview tab. */
  sessionActions?: (detail: RunDetail, container: HTMLElement) => void;
  /** T8: extra tabs, e.g. `review`. Ids must be added to DETAIL_TABS in view-model.ts. */
  tabs?: Partial<Record<DetailTabId, (detail: RunDetail, container: HTMLElement) => void>>;
}
const extensions: DetailExtensions = {};

const host = connectHost();
const store = createPanelStore({ host });

let mounted = false;

host.onReady(context => {
  // Every snapshot (theme or session change) repaints the theme; only the first one mounts.
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  mountPanel();
});

function mountPanel(): void {
  const bannerRoot = required('banner');
  const listView = required('list-view');
  const detailView = required('detail-view');
  const listNoticeNode = required('list-notice');
  const detailContent = required('detail-content');

  const retryOrClear = (kind: 'retry' | 'clear-filters' | undefined): (() => void) =>
    kind === 'clear-filters'
      ? () => store.setFilters({ projectId: null, status: null })
      : () => store.retry();

  const banner = mountBanner(bannerRoot, { tone: 'info', title: 'Connecting to Heimdall…' });
  const projectSelect = mountSelect(required('filter-project'), {
    label: 'Project',
    value: ALL_FILTER,
    options: projectFilterOptions([]),
    onChange: id => store.setFilters({ projectId: id === ALL_FILTER ? null : id }),
  });
  const statusSelect = mountSelect(required('filter-status'), {
    label: 'Status',
    value: ALL_FILTER,
    options: statusFilterOptions(),
    onChange: id => store.setFilters({
      status: (RUN_STATUSES as readonly string[]).includes(id) ? id as WireRunStatus : null,
    }),
  });

  // Keyboard: the SDK list handles ArrowUp/ArrowDown (and Ctrl+N/P), Home/End and Enter/Space through
  // navigationKey and moveListSelection; the list element is focusable (tabindex 0, role listbox).
  const list = mountList(required('run-list'), {
    items: [],
    selectedId: null,
    ariaLabel: 'Heimdall runs',
    emptyText: '',
    onSelect: id => store.select(id),
  });
  let emptyAction: (() => void) | undefined;
  const empty = mountEmpty(required('list-empty'), { title: '' });

  mountButton(required('detail-back'), {
    label: '← Back to runs',
    variant: 'ghost',
    size: 'sm',
    onClick: () => goBack(),
  });
  let tab: DetailTabId = 'overview';
  const expandedTasks = new Set<string>();
  let detailHandles: Array<{ dispose: () => void }> = [];
  let renderedDetail: RunDetail | null = null;
  let renderedKey = '';
  const painted = { project: '', status: '', rows: '' };

  const focusList = (): void => {
    const target = required('run-list').querySelector<HTMLElement>('[role="listbox"]');
    target?.focus();
  };
  const goBack = (): void => {
    store.select(null);
    // The list view is shown again by the render below; focus once it is visible.
    queueMicrotask(focusList);
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && store.getState().selectedRunId !== null) {
      event.preventDefault();
      goBack();
    }
  });

  const navigation = createNavigation({ host, matcher: createPanelClient(host) });
  let sessionHandles: Array<{ dispose: () => void }> = [];
  let sessionGen = 0;
  const disposeSessions = (): void => {
    sessionGen++;
    for (const handle of sessionHandles) handle.dispose();
    sessionHandles = [];
  };

  const disposeDetail = (): void => {
    disposeSessions();
    for (const handle of detailHandles) handle.dispose();
    detailHandles = [];
    renderedDetail = null;
    detailContent.replaceChildren();
  };

  function badge(parent: HTMLElement, value: Badge): void {
    const slot = node('span');
    parent.append(slot);
    detailHandles.push(mountBadge(slot, { label: value.label, tone: value.tone }));
  }

  function rows(parent: HTMLElement, items: LabeledRow[]): void {
    const dl = node('dl', 'hm-rows');
    for (const item of items) {
      const row = node('div', 'hm-row');
      row.append(node('dt', undefined, item.label), node('dd', undefined, item.value));
      dl.append(row);
    }
    parent.append(dl);
  }

  function section(parent: HTMLElement, title: string): HTMLElement {
    const el = node('section', 'hm-section');
    el.setAttribute('aria-label', title);
    el.append(node('h2', undefined, title));
    parent.append(el);
    return el;
  }

  function drawOverview(detail: RunDetail, body: HTMLElement): void {
    const status = section(body, 'Status');
    const head = node('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '8px';
    badge(head, statusBadge(detail));
    head.append(node('span', 'hm-text', phaseText(detail)));
    status.append(head);
    const blocker = blockerInfo(detail.blocker);
    if (blocker) {
      const box = node('div', 'hm-blocker');
      box.dataset.tone = blocker.tone;
      box.setAttribute('role', 'note');
      box.append(node('p', 'hm-blocker-title', blocker.title));
      box.append(node('p', 'hm-text', blocker.reason));
      if (blocker.resolution) {
        box.append(node('p', 'hm-label', 'Recorded resolution'), node('p', 'hm-text', blocker.resolution));
      }
      status.append(box);
    }

    const progress = section(body, 'Progress');
    const info = progressInfo(detail);
    if (info.value === null) progress.append(node('p', 'hm-text', info.label));
    else {
      const slot = node('div');
      progress.append(slot);
      detailHandles.push(mountProgress(slot, { value: info.value, tone: info.tone, label: info.label }));
    }

    const current = section(body, 'Current task');
    current.append(node('p', 'hm-text', currentTaskText(detail)));

    const models = section(body, 'Models');
    rows(models, modelRows(detail.models));

    const slot = node('div', 'hm-slot');
    slot.dataset.slot = 'session-actions';
    body.append(slot);
    extensions.sessionActions?.(detail, slot);
  }

  /** Session actions for the Overview tab: open the run's existing sessions, or explain why they cannot be opened. */
  function drawSessions(detail: RunDetail, container: HTMLElement): void {
    disposeSessions();
    const gen = sessionGen;
    const shell = section(container, 'Sessions');
    const status = node('p', 'hm-text', 'Checking which sessions OpenChamber has loaded…');
    status.setAttribute('role', 'status');
    const body = node('div', 'hm-sessions');
    const feedback = node('p', 'hm-text');
    feedback.setAttribute('role', 'alert');
    feedback.hidden = true;
    shell.append(status, body, feedback);

    const known = store.getState().projects.find(entry => entry.id === detail.projectId);
    const project = { id: detail.projectId, name: known?.name ?? detail.projectName, directory: known?.directory ?? null };
    function paint(result: NavigationView): void {
      for (const handle of sessionHandles) handle.dispose();
      sessionHandles = [];
      body.replaceChildren();
      status.textContent = result.message ?? '';
      status.hidden = result.message === null;
      if (result.copyText !== null) {
        const copy = node('code', 'hm-copy', result.copyText);
        copy.tabIndex = 0;
        copy.setAttribute('aria-label', `Project directory: ${result.copyText}`);
        body.append(copy);
      }
      for (const entry of result.targets) {
        const row = node('div', 'hm-session');
        const slot = node('div');
        row.append(slot);
        sessionHandles.push(mountButton(slot, {
          label: entry.actionLabel,
          variant: 'outline',
          size: 'sm',
          disabled: !entry.enabled,
          onClick: () => {
            void navigation.open(result, entry.target.key).then(outcome => {
              if (gen !== sessionGen) return;
              feedback.textContent = outcome.message ?? '';
              feedback.hidden = outcome.message === null;
            });
          },
        }));
        if (result.state === 'listed' && entry.note) row.append(node('p', 'hm-meta', entry.note));
        body.append(row);
      }
      if (result.canRefresh) {
        const slot = node('div');
        body.append(slot);
        sessionHandles.push(mountButton(slot, { label: 'Refresh sessions', variant: 'ghost', size: 'sm', onClick: () => check() }));
      }
    }

    function check(): void {
      feedback.hidden = true;
      status.hidden = false;
      status.textContent = 'Checking which sessions OpenChamber has loaded…';
      void navigation.load(detail, project).then(result => {
        if (gen === sessionGen) paint(result);
      });
    }
    check();
  }

  function drawUsage(detail: RunDetail, body: HTMLElement): void {
    const usage = usageInfo(detail.usage);
    const totals = section(body, 'Usage');
    rows(totals, [
      { label: 'Reported tokens', value: usage.reported },
      { label: 'Uncached', value: usage.uncached },
    ]);
    totals.append(node('p', 'hm-meta', usage.note));
    if (usage.sessions.length > 0) rows(totals, usage.sessions);
    const limits = section(body, 'Limits');
    rows(limits, limitRows(detail.limits));
  }

  function drawTasks(detail: RunDetail, body: HTMLElement): void {
    const items = taskRows(detail.tasks);
    if (items.length === 0) {
      body.append(node('p', 'hm-text', 'No task list has been recorded for this run.'));
      return;
    }
    for (const task of items) {
      const details = node('details', 'hm-task');
      details.open = expandedTasks.has(task.id);
      details.addEventListener('toggle', () => {
        if (details.open) expandedTasks.add(task.id);
        else expandedTasks.delete(task.id);
      });
      const summary = node('summary');
      badge(summary, task.badge);
      summary.append(node('span', 'hm-task-title', `${task.id}: ${task.title}`));
      details.append(summary);
      const inner = node('div', 'hm-task-body');
      if (task.summary) inner.append(node('p', 'hm-label', 'Summary'), node('p', 'hm-text', task.summary));
      if (task.handoff) inner.append(node('p', 'hm-label', 'Handoff'), node('p', 'hm-text', task.handoff));
      if (task.model) inner.append(node('p', 'hm-label', 'Model'), node('p', 'hm-text', task.model));
      if (task.evidence.length > 0) {
        inner.append(node('p', 'hm-label', 'Evidence'));
        for (const evidence of task.evidence) {
          const box = node('div', 'hm-evidence');
          const row = node('div', 'hm-evidence-head');
          badge(row, evidence.badge);
          row.append(node('span', 'hm-text', [evidence.gateId, evidence.gate].filter(Boolean).join(': ') || 'Check'));
          box.append(row);
          if (evidence.detail) box.append(node('p', 'hm-text', evidence.detail));
          inner.append(box);
        }
      } else if (task.badge.label === 'Done') {
        inner.append(node('p', 'hm-meta', 'No evidence was recorded for this task.'));
      }
      if (task.truncated) inner.append(node('p', 'hm-meta', 'Some text for this task was shortened.'));
      details.append(inner);
      body.append(details);
    }
  }

  const drawers: Record<DetailTabId, (detail: RunDetail, body: HTMLElement) => void> = {
    overview: drawOverview,
    usage: drawUsage,
    tasks: drawTasks,
  };

  function drawDetail(detail: RunDetail): void {
    disposeDetail();
    renderedDetail = detail;
    detailContent.append(node('h2', 'hm-detail-title', detail.label));
    detailContent.append(node('p', 'hm-meta', `${detail.projectName} · updated ${formatAge(detail.updatedAt, Date.now())} (${formatTime(detail.updatedAt)})`));
    const notice = truncationNotice(detail);
    if (notice) detailContent.append(node('p', 'hm-meta', notice));
    const tabRoot = node('div');
    detailContent.append(tabRoot);
    const handle = mountTabs(tabRoot, {
      items: detailTabs(detail),
      activeId: tab,
      onChange: next => {
        tab = next as DetailTabId;
        drawDetail(detail);
      },
    });
    detailHandles.push(handle);
    const body = node('div', 'hm-detail');
    body.setAttribute('role', 'tabpanel');
    detailContent.append(body);
    (extensions.tabs?.[tab] ?? drawers[tab])(detail, body);
  }

  function renderDetail(state: PanelState): void {
    const placeholder = detailPlaceholder(state);
    if (placeholder !== null) {
      const key = `placeholder:${placeholder}`;
      if (key === renderedKey) return;
      renderedKey = key;
      disposeDetail();
      detailContent.append(node('p', 'hm-text', placeholder));
      return;
    }
    if (state.detail === renderedDetail && renderedKey === 'detail') return;
    renderedKey = 'detail';
    const scroller = document.scrollingElement;
    const top = scroller?.scrollTop ?? 0;
    if (state.detail) drawDetail(state.detail);
    if (scroller) scroller.scrollTop = top;
  }

  function render(state: PanelState): void {
    const info = bannerInfo(state, Date.now());
    bannerRoot.hidden = info === null;
    if (info) {
      banner.update({
        tone: info.tone,
        title: info.title,
        body: info.body,
        action: info.action ? { label: info.action.label, onClick: retryOrClear(info.action.kind) } : undefined,
      });
    }

    const detailOpen = state.selectedRunId !== null;
    listView.hidden = detailOpen;
    detailView.hidden = !detailOpen;
    if (detailOpen) {
      renderDetail(state);
      return;
    }
    renderedKey = '';

    // Components are repainted only when their inputs changed, so an open select popup or the list's
    // keyboard-active row survives the periodic polls.
    const project = { value: state.filters.projectId ?? ALL_FILTER, options: projectFilterOptions(state.projects) };
    const projectKey = JSON.stringify(project);
    if (projectKey !== painted.project) {
      painted.project = projectKey;
      projectSelect.update(project);
    }
    const statusValue = state.filters.status ?? ALL_FILTER;
    if (statusValue !== painted.status) {
      painted.status = statusValue;
      statusSelect.update({ value: statusValue });
    }

    const rowsData = runRows(state.runs);
    const rowsKey = JSON.stringify(rowsData);
    if (rowsKey !== painted.rows) {
      painted.rows = rowsKey;
      list.update({
        items: rowsData.map(row => ({
          id: row.id,
          title: row.title,
          subtitle: row.subtitle,
          meta: row.meta || undefined,
          badge: { label: row.badge.label, tone: row.badge.tone },
        })),
        selectedId: null,
      });
    }
    required('run-list').hidden = rowsData.length === 0;

    const notice = listNotice(state);
    listNoticeNode.hidden = notice === null;
    listNoticeNode.textContent = notice ?? '';

    const emptyState = emptyInfo(state);
    required('list-empty').hidden = emptyState === null;
    if (emptyState) {
      emptyAction = emptyState.action ? retryOrClear(emptyState.action.kind) : undefined;
      empty.update({
        title: emptyState.title,
        body: emptyState.body,
        action: emptyState.action && emptyAction ? { label: emptyState.action.label, onClick: emptyAction } : undefined,
      });
    }
  }

  extensions.sessionActions = drawSessions;

  // Keep "x s ago" fresh without waiting for the next state change.
  setInterval(() => render(store.getState()), 15000);

  store.subscribe(render);
  render(store.getState());
  store.start();
}
