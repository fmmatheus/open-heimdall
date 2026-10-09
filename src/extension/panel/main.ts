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
  DEFAULT_DETAIL_TAB,
  bannerInfo,
  detailPlaceholder,
  detailTabs,
  emptyInfo,
  listNotice,
  projectFilterOptions,
  runRows,
  statusFilterOptions,
  summaryInfo,
  taskRows,
  technicalSections,
  truncationNotice,
} from './view-model.js';
import type { Badge, DetailTabId, LabeledRow } from './view-model.js';
import { reviewView } from './review-view.js';
import type { DiffView, ReviewView } from './review-view.js';
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

/** Extension points for other tasks. Each renderer receives the loaded detail and a container to fill. */
export interface DetailExtensions {
  /** Session actions, drawn in the summary above the tabs (`data-slot="summary-actions"`). */
  summaryActions?: (detail: RunDetail, container: HTMLElement) => void;
  /** Replacement renderers for a tab; ids must be listed in DETAIL_TABS in view-model.ts. */
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
  let tab: DetailTabId = DEFAULT_DETAIL_TAB;
  const expandedTasks = new Set<string>();
  let detailHandles: Array<{ dispose: () => void }> = [];
  let renderedDetail: RunDetail | null = null;
  let renderedKey = '';
  /** Repaints the Review tab in place; set only while that tab is drawn. */
  let reviewPainter: ((state: PanelState) => void) | null = null;
  /** Refreshes the summary's "Updated … ago" line between polls; set while a detail is drawn. */
  let updatedPainter: (() => void) | null = null;
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
    reviewPainter = null;
    updatedPainter = null;
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

  /**
   * Persistent summary above the tabs: one status badge, progress and current action, models, recorded
   * usage and budget, the recorded blocker, and a slot for session actions. Troubleshooting data lives in
   * the Technical details tab.
   */
  function drawSummary(detail: RunDetail, container: HTMLElement): void {
    const info = summaryInfo(detail, Date.now());
    const box = node('section', 'hm-summary');
    box.setAttribute('aria-label', 'Run summary');
    box.append(node('h2', 'hm-detail-title', info.label));
    const head = node('div', 'hm-summary-head');
    head.append(node('span', 'hm-text', info.project));
    badge(head, info.badge);
    box.append(head);

    if (info.progress.value !== null) {
      const slot = node('div');
      box.append(slot);
      detailHandles.push(mountProgress(slot, { value: info.progress.value, tone: info.progress.tone, label: info.headline }));
    } else {
      box.append(node('p', 'hm-text', info.headline));
    }
    for (const line of [...info.models, ...info.usage]) box.append(node('p', 'hm-meta', line));
    const updated = node('p', 'hm-meta', info.updated);
    updated.title = info.updatedExact;
    box.append(updated);
    updatedPainter = () => {
      const next = summaryInfo(detail, Date.now());
      updated.textContent = next.updated;
    };

    if (info.blocker) {
      const blocker = node('div', 'hm-blocker');
      blocker.dataset.tone = info.blocker.tone;
      blocker.setAttribute('role', 'note');
      blocker.append(node('p', 'hm-blocker-title', info.blocker.title));
      blocker.append(node('p', 'hm-text', info.blocker.reason));
      if (info.blocker.resolution) {
        blocker.append(node('p', 'hm-label', 'Recorded resolution'), node('p', 'hm-text', info.blocker.resolution));
      }
      box.append(blocker);
    }

    const slot = node('div', 'hm-slot');
    slot.dataset.slot = 'summary-actions';
    box.append(slot);
    extensions.summaryActions?.(detail, slot);
    container.append(box);
  }

  /** Technical details tab: every recorded model, usage, limit and identifier, with exact UTC times. */
  function drawTechnical(detail: RunDetail, body: HTMLElement): void {
    for (const entry of technicalSections(detail)) {
      const box = section(body, entry.title);
      rows(box, entry.rows);
      if (entry.note) box.append(node('p', 'hm-meta', entry.note));
    }
  }

  /** Sessions tab: open the run's existing sessions, or explain why they cannot be opened. */
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

  /**
   * Review tab. The structure is built once per draw; `paintReview` then updates it in place whenever the
   * store's review slice changes, so a poll does not reset the file list's focus or the diff's scroll position.
   * Every file name and diff line is written with textContent.
   */
  function drawReview(_detail: RunDetail, body: HTMLElement): void {
    const root = node('div', 'hm-review');
    body.append(root);

    const bar = node('div', 'hm-review-bar');
    const refreshSlot = node('div');
    bar.append(refreshSlot);
    const status = node('p', 'hm-meta');
    status.setAttribute('role', 'status');
    bar.append(status);
    detailHandles.push(mountButton(refreshSlot, { label: 'Refresh review', variant: 'ghost', size: 'sm', onClick: () => store.refreshReview() }));

    const headerBox = node('section', 'hm-section');
    headerBox.setAttribute('aria-label', 'Review baseline');
    const notices = node('div', 'hm-review-notices');
    const unavailable = node('div', 'hm-blocker');
    unavailable.setAttribute('role', 'note');
    const filesBox = node('section', 'hm-section');
    filesBox.setAttribute('aria-label', 'Changed files');
    const filesTitle = node('h2', undefined, 'Changed files');
    const listSlot = node('div');
    const empty = node('p', 'hm-text');
    const generatedBox = node('details', 'hm-generated');
    const generatedSummary = node('summary');
    const generatedNote = node('p', 'hm-meta');
    const generatedList = node('ul', 'hm-generated-list');
    generatedBox.append(generatedSummary, generatedNote, generatedList);
    filesBox.append(filesTitle, listSlot, empty, generatedBox);
    const diffBox = node('section', 'hm-section');
    diffBox.setAttribute('aria-label', 'File diff');
    const comparison = node('p', 'hm-meta');
    comparison.setAttribute('role', 'note');
    root.append(bar, notices, headerBox, unavailable, filesBox, diffBox, comparison);

    const fileList = mountList(listSlot, {
      items: [],
      selectedId: null,
      ariaLabel: 'Changed files',
      emptyText: '',
      onSelect: path => store.selectReviewFile(path),
    });
    detailHandles.push(fileList);

    const painted = { header: '', files: '', generated: '', diff: '', selected: '' };

    function paintHeader(view: ReviewView): void {
      const key = `${view.mode}:${JSON.stringify(view.header)}`;
      if (key === painted.header) return;
      painted.header = key;
      headerBox.replaceChildren();
      headerBox.hidden = view.header === null;
      if (view.header === null) return;
      headerBox.append(node('h2', undefined, 'Baseline'));
      const items: LabeledRow[] = [
        { label: 'Base commit', value: view.header.baseCommit },
        { label: 'Branch', value: view.header.branch },
      ];
      if (view.header.head !== null) items.push({ label: 'Worktree HEAD', value: view.header.head });
      if (view.mode === 'ready') {
        items.push({ label: 'Changes', value: view.header.lines ? `${view.header.summary} · ${view.header.lines}` : view.header.summary });
        if (view.header.binary > 0) items.push({ label: 'Binary files', value: String(view.header.binary) });
      }
      rows(headerBox, items);
      const full = headerBox.querySelector('dd');
      if (full) full.title = view.header.baseCommitFull;
    }

    function paintGenerated(view: ReviewView): void {
      const key = JSON.stringify(view.generated);
      if (key === painted.generated) return;
      painted.generated = key;
      generatedBox.hidden = view.generated === null;
      generatedList.replaceChildren();
      if (view.generated === null) return;
      generatedSummary.textContent = `${view.generated.label} (${view.generated.count})`;
      generatedNote.textContent = view.generated.note;
      for (const entry of view.generated.rows) {
        generatedList.append(node('li', 'hm-generated-item', `${entry.letter} ${entry.path}`));
      }
    }

    function paintDiff(view: ReviewView): void {
      const key = JSON.stringify(view.diff);
      if (key === painted.diff) return;
      painted.diff = key;
      diffBox.replaceChildren();
      diffBox.hidden = view.diff === null;
      if (view.diff !== null) drawDiff(diffBox, view.diff);
    }

    function paintReview(state: PanelState): void {
      const view = reviewView(state.review);
      status.textContent = view.mode === 'loading' ? 'Loading review…' : view.refreshing ? 'Refreshing…' : '';
      status.hidden = status.textContent === '';
      notices.replaceChildren(...view.notices.map(text => node('p', 'hm-meta', text)));
      notices.hidden = view.notices.length === 0;
      const problem = view.mode === 'error' || view.mode === 'unavailable';
      unavailable.hidden = !problem;
      unavailable.dataset.tone = view.tone;
      unavailable.replaceChildren();
      if (problem) {
        if (view.title) unavailable.append(node('p', 'hm-blocker-title', view.title));
        if (view.message) unavailable.append(node('p', 'hm-text', view.message));
      }
      comparison.hidden = view.mode === 'loading';
      comparison.textContent = view.mode === 'loading' ? '' : view.note;

      paintHeader(view);
      const ready = view.mode === 'ready';
      filesBox.hidden = !ready;
      if (!ready) { painted.files = ''; painted.generated = ''; painted.diff = ''; diffBox.hidden = true; return; }
      const filesKey = JSON.stringify(view.files);
      if (filesKey !== painted.files) {
        painted.files = filesKey;
        fileList.update({
          items: view.files.map(row => ({ id: row.id, title: row.title, leading: row.leading, subtitle: row.subtitle, meta: row.meta || undefined })),
          selectedId: view.selectedPath,
        });
        painted.selected = view.selectedPath ?? '';
      } else if ((view.selectedPath ?? '') !== painted.selected) {
        painted.selected = view.selectedPath ?? '';
        fileList.update({ selectedId: view.selectedPath });
      }
      listSlot.hidden = view.files.length === 0;
      empty.hidden = view.emptyText === null;
      empty.textContent = view.emptyText ?? '';
      filesTitle.textContent = view.files.length > 0 ? `Changed files (${view.files.length})` : 'Changed files';
      paintGenerated(view);
      paintDiff(view);
    }

    reviewPainter = paintReview;
    paintReview(store.getState());
  }

  function drawDiff(parent: HTMLElement, view: DiffView): void {
    const title = node('h2', undefined, 'Diff');
    parent.append(title, node('p', 'hm-diff-path', view.path));
    if (view.stats) parent.append(node('p', 'hm-meta', view.stats));
    for (const text of view.notices) parent.append(node('p', 'hm-meta', text));
    if (view.mode !== 'diff') {
      const message = node('p', 'hm-text', view.message ?? '');
      if (view.mode === 'loading') message.setAttribute('role', 'status');
      if (view.mode === 'error') message.setAttribute('role', 'alert');
      parent.append(message);
      return;
    }
    const pre = node('pre', 'hm-diff');
    pre.tabIndex = 0;
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', `Diff of ${view.path}`);
    for (const line of view.lines) {
      const row = node('span', 'hm-diff-line', line.text);
      row.dataset.kind = line.kind;
      pre.append(row, document.createTextNode('\n'));
    }
    parent.append(pre);
  }

  const drawers: Record<DetailTabId, (detail: RunDetail, body: HTMLElement) => void> = {
    sessions: drawSessions,
    tasks: drawTasks,
    review: drawReview,
    details: drawTechnical,
  };

  function drawDetail(detail: RunDetail): void {
    disposeDetail();
    renderedDetail = detail;
    drawSummary(detail, detailContent);
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
    // The store loads the review only while its tab is showing.
    store.setReviewVisible(tab === 'review');
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
    if (state.detail === renderedDetail && renderedKey === 'detail') {
      updatedPainter?.();
      reviewPainter?.(state);
      return;
    }
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

    const rowsData = runRows(state.runs, Date.now());
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

  // Keep "x s ago" fresh without waiting for the next state change.
  setInterval(() => render(store.getState()), 15000);

  store.subscribe(render);
  render(store.getState());
  store.start();
}
