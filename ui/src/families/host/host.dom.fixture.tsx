import { Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { APPEARANCE_EVENT } from '../../shell/appearance/events.ts';
import { tooltipStore } from '../../charts/tooltip.ts';
import TooltipLayer from '../../charts/TooltipLayer.tsx';
import type { DashboardClient, DashboardSource } from '../../dashboard/client';
import type { WidgetRuntime } from '../../dashboard/definitions';
import { pipelineFor, type LaneWorker, type PipelineHost } from '../../dashboard/follow/pipeline.ts';
import { FollowedWidgetKey } from '../../dashboard/follow/store.ts';
import { answerBody } from '../../dashboard/follow/messages.fixture.ts';
import { packet, resetStamps, splitForLanes } from '../../dashboard/follow/split.ts';
import type { WidgetSpec } from '../../dashboard/model';
import { PlaybackController } from '../../dashboard/playback.ts';
import { WidgetFrameContext } from '../../dashboard/widgetFrame.tsx';
import type { FromLane, ToLane } from '../../draw/laneMessages';
import { laneDispatch } from '../../draw/laneDispatch.ts';
import { measureWith, PerfRecorder } from '../../shell/perf.ts';
import type { InstalledAction } from '../contract.ts';
import { createLaneView } from '../laneRuntime.ts';
import { tableLane } from '../table/laneView.ts';
import { ROW_HEIGHT, tableSettingsOf } from '../table/settings.ts';
import { registerFamilyProjection } from '../registry.ts';
import type { TableColumnSpec, TableModel, TableModelSlot, TableRow } from '../table/model.ts';
import { SCOREBOARD_FIXTURE_COLUMNS, scoreboardColumnsSpec, scoreboardProjection } from '../table/tableFamilyDom.fixture.ts';
import { tableHostAdapter } from '../table/hostAdapter.ts';
import TableChrome from '../table/TableChrome.tsx';
import { timeChartHostAdapter } from '../time-chart/hostAdapter.ts';
import { timeChartLane } from '../time-chart/laneView.ts';
import type { TimeChartModel } from '../time-chart/model.ts';
import { readFamilyTheme } from '../theme.ts';
import { formatDateHover } from '../valueFormat.ts';
import FamilyHost, { type PointsNavigateRequest } from './FamilyHost.tsx';
import DeclaredFamilyWidget, { type DeclaredFamilyWidgetProps } from './DeclaredFamilyWidget.tsx';
import type { FamilyPlanContext, SourcePlan } from '../contract.ts';
import type { IdentitySnapshot } from '../identity/types.ts';
import type { FamilyStaticSources } from './adapter.ts';
import type { TiledLine } from '../../dashboard/tiles/view.ts';
import type { PagedRows } from '../table/rowSource.ts';
import type { ArtResolutions } from '../art/provider.ts';
import '../../styles.css';

type FollowAnswer = { id: number; hour: number; body: Uint8Array };
const routesBySub = new Map<number, number>();

function followMessage(route: number, hour: number, seek: number, answers: FollowAnswer[], reset = false) {
  const out = new Uint8Array(24 + answers.reduce((sum, a) => sum + 16 + a.body.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x334c4f46, true);
  view.setUint32(4, (route << 1) | (reset ? 1 : 0), true);
  view.setInt32(8, hour, true);
  view.setUint32(12, answers.length, true);
  view.setUint32(16, seek, true);
  let at = 24;
  for (const a of answers) {
    view.setUint32(at, a.id, true);
    view.setInt32(at + 4, a.hour, true);
    view.setUint32(at + 8, a.body.length, true);
    out.set(a.body, at + 16);
    at += 16 + a.body.length;
  }
  return out;
}

let ports: readonly MessagePort[] = [];
let seek = 0;
const stamp = resetStamps();
const send = (bytes: Uint8Array) => {
  const resets = stamp(bytes);
  const split = splitForLanes(bytes, ports.length);
  split.lanes.forEach((part, lane) => {
    if (part) ports[lane]!.postMessage(packet('follow', part, resets), [part.buffer]);
  });
};

function makeSource(id: string): DashboardSource {
  return {
    id,
    revision: 'r1',
    path: id,
    metadata: { branches: [{ id: '1', firstHour: 0, lastHour: 2000 }] },
  } as unknown as DashboardSource;
}

const sourceA = makeSource('camp-A');
const sourceB = makeSource('camp-B');

const client = {
  available: true,
  openFollow: (opened: readonly MessagePort[]) => { ports = opened; return Promise.resolve(); },
  product: async (request: { product: string; sourceId: string; revision: string; params: { hour?: number; id: number; route: number } }) => {
    if (request.product === 'follow') {
      const { id, route } = request.params;
      routesBySub.set(id, route);
      return { data: { available: true, route } };
    }
    if (request.product === 'span-history') return { sourceId: request.sourceId, revision: request.revision, product: request.product, data: { through: request.params.hour } };
    return { data: { available: true } };
  },
} as unknown as DashboardClient;

const clock = new PlaybackController();
const paintsByWidget = new Map<number, number>();
let payloadTips = false;
let hoverRanking: readonly string[] | null = null;
let mirrorMetaOverride: { readonly summaryText: string; readonly summaryPartial: string | null; readonly warnings?: readonly string[] } | null = null;
let reportGenericDiagnostics: ((lines: string[]) => void) | undefined;
let genericHeader: HTMLDivElement | null = null;
let dropNextPopulatedMirror = false;
const hoverReports: Array<readonly [number | null, readonly string[] | undefined]> = [];
let holdHitsForPipe: number | null = null;
const heldHits: Array<{ readonly key: string | null; readonly deliver: () => void }> = [];
const hitWaiters = new Set<() => void>();

type PaintedField = { readonly value: unknown; readonly content: string };
function asPayloadTip(field: unknown): unknown {
  const tip = field as PaintedField | undefined;
  const value = tip?.value as { key: string; text: { hour: number; rowKey: string; content: { title: string } } | null } | undefined;
  if (!tip || !value?.text) return field;
  const { hour, rowKey, content } = value.text;
  return { value: { key: value.key, text: { hour, rowKey, payload: { title: content.title } } }, content: tip.content };
}
clock.setBounds({ firstHour: 0, lastHour: 2000 });

function createLane(): LaneWorker {
  const worker: LaneWorker = {
    onmessage: null,
    postMessage(message: ToLane) {
      queueMicrotask(() => dispatch(message));
    },
  };
  const dispatch = laneDispatch(
    (message: FromLane) => {
      if (message.type === 'hit' && holdHitsForPipe === message.widget) {
        heldHits.push({
          key: message.key,
          deliver: () => {
            queueMicrotask(() => worker.onmessage?.({ data: message } as MessageEvent<FromLane>));
          },
        });
        for (const wake of [...hitWaiters]) {
          hitWaiters.delete(wake);
          wake();
        }
        return;
      }
      queueMicrotask(() => worker.onmessage?.({ data: message } as MessageEvent<FromLane>));
    },
    {
      views: (kind, wake) => {
        if (kind === 'time-chart') return createLaneView(timeChartLane, wake);
        const view = createLaneView(tableLane, wake);
        const paint = view.paint.bind(view);
        view.paint = (input, state, content) => {
          paintsByWidget.set(input.widget, (paintsByWidget.get(input.widget) ?? 0) + 1);
          const painted = paint(input, state, content);
          if (painted.mode !== undefined && painted.mode !== 'picture') return painted;
          const fields: Record<string, PaintedField> = { ...(painted.fields as Record<string, PaintedField>), accessibleDescription: { value: 'Four countries ranked by factories', content: 'description' },
            ...(hoverRanking ? { drawnKeys: { value: { main: hoverRanking }, content: hoverRanking.join(',') } } : {}),
            ...(mirrorMetaOverride ? {
              meta: {
                value: { ...(painted.fields.meta?.value as Record<string, unknown> | undefined), ...mirrorMetaOverride },
                content: JSON.stringify(mirrorMetaOverride),
              },
            } : {}) };
          if (payloadTips && 'focusTooltip' in fields) fields.focusTooltip = asPayloadTip(fields.focusTooltip) as PaintedField;
          if (dropNextPopulatedMirror && fields.mirror) {
            const rows = (fields.mirror.value as { readonly rows?: readonly unknown[] } | undefined)?.rows;
            if (Array.isArray(rows) && rows.length > 0) {
              dropNextPopulatedMirror = false;
              delete fields.mirror;
            }
          }
          return { ...painted, fields };
        };
        return view;
      },
      crop: sources => Promise.all(sources.map(source => createImageBitmap(source as OffscreenCanvas))),
      later: run => requestAnimationFrame(() => run()),
    },
  );
  return worker;
}

const workers = [0, 1].map(() => createLane());
const host: PipelineHost = {
  lanes: workers,
  open: list => client.openFollow!(list),
  channel: () => new MessageChannel(),
  frameRate: () => 60,
  rate: () => 1,
};
const pipeline = pipelineFor(clock, client, () => host);

const SPECS = scoreboardColumnsSpec(SCOREBOARD_FIXTURE_COLUMNS, null);
const SETTINGS = {
  ...tableSettingsOf(undefined, SPECS, { density: 'comfortable', sort: { column: 'factories', direction: 'descending' } }),
  order: SPECS.map(s => s.key),
  sort: { column: 'factories', direction: 'descending' as const },
};
const OPTIONS = {
  shown: SCOREBOARD_FIXTURE_COLUMNS,
  candidates: ['GER', 'FRA', 'ITA', 'ENG'],
  top: null,
  rankMarkers: false,
};

function makeRuntime(src: DashboardSource): WidgetRuntime {
  return {
    client,
    clock,
    tracks: [{ id: 't1', source: src, branch: { id: '1', firstHour: 0, lastHour: 2000 }, axisOffset: 0 }],
  } as unknown as WidgetRuntime;
}

function makeSubs(src: DashboardSource) {
  return [
    { name: 'factories', source: src, branch: '1', offset: 0, query: { product: 'series-state', params: { branchId: '1', col: 'factories' } }, channel: 'followed' as const },
    { name: 'casualties', source: src, branch: '1', offset: 0, query: { product: 'series-state', params: { branchId: '1', col: 'casualties' } }, channel: 'followed' as const },
  ];
}

const widget: WidgetSpec = {
  id: 'w-host-test',
  kind: 'scoreboard',
  trackIds: ['t1'],
  time: { mode: 'follow' },
  countries: { kind: 'all' },
  options: {},
  layout: { x: 0, y: 0, w: 12, h: 12 },
} as unknown as WidgetSpec;

const nextPoll = () => new Promise<void>(resolve => setTimeout(resolve, 16));
async function until(predicate: () => boolean, limitMs = 5000) {
  const deadline = performance.now() + limitMs;
  while (!predicate() && performance.now() < deadline) await nextPoll();
  return predicate();
}

function sendHour(subIds: readonly number[], hour: number, fac: [bigint, bigint, bigint, bigint], reset = false) {
  const names = ['GER', 'FRA', 'ITA', 'ENG'];
  const keys = [1n, 2n, 3n, 4n];
  const facBody = answerBody({ keys, columns: 1, names, values: [...fac], states: [0, 0, 0, 0] });
  const casBody = answerBody({ keys, columns: 1, names, values: [10n, 20n, 30n, 40n], states: [0, 0, 0, 0] });
  const answersByRoute = new Map<number, FollowAnswer[]>();
  for (const [index, id] of subIds.entries()) {
    const route = routesBySub.get(id);
    if (route === undefined) throw new Error(`No native route for follow ${id}`);
    let answers = answersByRoute.get(route);
    if (!answers) answersByRoute.set(route, answers = []);
    answers.push({ id, hour, body: index % 2 === 0 ? facBody : casBody });
  }
  for (const [route, answers] of answersByRoute) send(followMessage(route, hour, seek, answers, reset));
}

function subsForPipe(pipeId: number): number[] {
  const internal = pipeline as unknown as { widgets: Map<number, { subs: Map<object, number> }> };
  return [...(internal.widgets.get(pipeId)?.subs.values() ?? [])];
}


const { chromeState: _chrome, ...tableWithoutChrome } = tableHostAdapter;
const BODY_FOCUS_ADAPTER = { ...tableWithoutChrome, mirrorFocus: 'body' as const };
const LISTBOX_ADAPTER = { ...tableWithoutChrome, mirror: 'listbox' as const, mirrorFocus: 'body' as const };
const POINT_HOVER_ADAPTER = { ...tableHostAdapter, navigation: 'points' as const, parseHit: (key: string | null) => key ? { key, hour: 90 } : null };

const emptyToRowsProjection = registerFamilyProjection({
  family: 'table',
  kind: 'host-empty-to-rows',
  project(readView): TableModel {
    const slots: TableModelSlot[] = readView.hour <= 50
      ? []
      : [{ kind: 'gap', key: 'gap:50:60', firstHour: 50, lastHour: 60, reason: 'Collector detached' }];
    return {
      hour: readView.hour,
      columns: DEEP_LOG_COLUMNS,
      rows: [],
      slots,
      unsorted: true,
      windowOffset: 0,
      totalRows: 10,
    };
  },
});

const POINTS_EXTENT: readonly [number, number] = [0, 24];
const POINTS_OPTIONS = {};
const POINTS_STATICS: FamilyStaticSources = { stamp: {}, proof: null, panels: {}, hour: 24 };
const pointsChartProjection = registerFamilyProjection({
  family: 'time-chart',
  kind: 'host-points-hover',
  project(): TimeChartModel {
    return {
      kind: 'host-points-hover',
      measureTitle: 'Stability',
      mode: 'lines',
      hour: 24,
      extent: POINTS_EXTENT,
      yAxis: { format: 'number', min: 0, max: 300 },
      series: [{
        id: 'metric',
        key: 'METRIC',
        name: 'Metric',
        color: readFamilyTheme()?.blue ?? 'CanvasText',
        role: 'primary',
        step: true,
        points: [
          { hour: 0, value: 10 },
          { hour: 3, value: 30 },
          { hour: 6, value: 60 },
          { hour: 12, value: 120 },
          { hour: 24, value: 240 },
        ],
        headValue: 240,
        headHour: 24,
        absentReason: null,
      }],
    };
  },
});
const pointsHoverHours: Array<number | null> = [];
const pointsNavRequests: PointsNavigateRequest[] = [];
let pendingPointsFocusHour: ((hour: number) => void) | null = null;

async function waitAnimationFrames(count: number) {
  for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function waitForPipeInstall(pipeId: number, check: () => boolean) {
  return check()
    ? Promise.resolve()
    : new Promise<void>(resolve => {
        const stop = pipeline.onInstall(pipeId, () => {
          if (!check()) return;
          stop();
          resolve();
        });
      });
}

async function waitForTooltipSubtitle(expectedSubtitle: string) {
  if (tooltipStore.get()?.content.subtitle !== expectedSubtitle) {
    await new Promise<void>(resolve => {
      const stop = tooltipStore.subscribe(() => {
        if (tooltipStore.get()?.content.subtitle !== expectedSubtitle) return;
        stop();
        resolve();
      });
    });
  }
  await waitAnimationFrames(1);
}

function readVisibleTooltip() {
  const el = document.querySelector<HTMLElement>('[role="tooltip"]');
  const open = !!el && el.matches(':popover-open');
  return {
    open,
    title: open ? (el.querySelector('strong')?.textContent ?? null) : null,
    subtitle: open ? (el.querySelector('.chart-tooltip-head small:not(.chart-tooltip-pinned)')?.textContent ?? null) : null,
    pinned: open ? (el.querySelector('.chart-tooltip-pinned')?.textContent ?? null) : null,
    rows: open
      ? [...el.querySelectorAll<HTMLElement>('.chart-tooltip-row')].map(row => [
          row.querySelector('span')?.textContent ?? '',
          row.querySelector('b')?.textContent ?? '',
        ] as const)
      : [],
  };
}

let root: Root | null = null;
let genericCommits = 0;
let genericActivated: InstalledAction[] = [];
let genericViewports: number[] = [];
const installCalls = new Map<number, number>();
const origOnInstall = pipeline.onInstall.bind(pipeline);
pipeline.onInstall = ((id: number, listener: () => void) => origOnInstall(id, () => {
  installCalls.set(id, (installCalls.get(id) ?? 0) + 1);
  listener();
})) as typeof pipeline.onInstall;
let container: HTMLDivElement | null = null;
let commits = 0;
let bindCount = 0;
let boundIds: number[] = [];
let staticCommits = 0;
const lastViewWindow = new Map<number, unknown>();
let staticSupplies: { readonly id: number; readonly statics: boolean; readonly tiledHead?: string; readonly hoverHour?: number; readonly paged?: unknown; readonly art?: unknown }[] = [];
let lastBoundModel: unknown = null;
let activated: string[] = [];
const tooltipRows: [string, string | null][] = [];
const deepFocusRows: (string | null)[] = [];
let currentState = {
  source: sourceA,
  active: true,
  frameToken: 1,
  secondMounted: false,
  genericMounted: false,
  genericBlocked: false,
  genericKeepFollowing: false,
  genericBodyFocus: false,
  genericListbox: false,
  genericEmptyToRows: false,
  primarySettings: SETTINGS,
  statics: null as FamilyStaticSources | null,
  tiled: undefined as Readonly<Record<string, ReadonlyMap<string, TiledLine>>> | undefined,
  hovers: undefined as Readonly<Record<string, { readonly hour: number; readonly data: unknown }>> | undefined,
  paged: undefined as PagedRows | undefined,
  windowed: false,
  spanMounted: false,
  deepLogMounted: false,
  deepLogPaged: undefined as PagedRows | undefined,
  pointsMode: null as null | 'focusKey' | 'pointsNavigate',
  owner: undefined as string | undefined,
};
const hoverRows: (string | null)[] = [];

const origBind = pipeline.bind.bind(pipeline);
pipeline.bind = ((...args: Parameters<typeof pipeline.bind>) => {
  bindCount++;
  boundIds.push(args[0]);
  lastBoundModel = args[4];
  return origBind(...args);
}) as typeof pipeline.bind;

const origSupply = pipeline.supply.bind(pipeline);
pipeline.supply = ((...args: Parameters<typeof pipeline.supply>) => {
  const statics = args[1].statics as { tiledBySource?: { main?: { GER?: { head?: string } } }; hovers?: { hover?: { hour?: number } }; pagedRows?: { log?: { mark?: unknown } }; artResolutions?: { mark?: unknown } } | null | undefined;
  const tiledHead = statics?.tiledBySource?.main?.GER?.head, hoverHour = statics?.hovers?.hover?.hour, paged = statics?.pagedRows?.log?.mark, art = statics?.artResolutions?.mark;
  const viewWindow = (args[1].statics as { window?: unknown } | null | undefined)?.window;
  if (viewWindow !== undefined) lastViewWindow.set(args[0], viewWindow);
  staticSupplies.push({ id: args[0], statics: args[1].statics !== undefined, ...(tiledHead !== undefined ? { tiledHead } : {}), ...(hoverHour !== undefined ? { hoverHour } : {}), ...(paged !== undefined ? { paged } : {}), ...(art !== undefined ? { art } : {}) });
  return origSupply(...args);
}) as typeof pipeline.supply;

const perf = new PerfRecorder();
measureWith(perf);

const staticArt = (() => {
  const listeners = new Set<() => void>();
  let resolutions: ArtResolutions | undefined;
  return {
    get resolutions() { return resolutions; },
    subscribe(changed: () => void) { listeners.add(changed); return () => { listeners.delete(changed); }; },
    land(next: ArtResolutions) { resolutions = next; for (const listener of listeners) listener(); },
  };
})();

let windowFirst = 0;
const WINDOWED_ADAPTER = { ...tableHostAdapter, rowWindow: () => ({ first: windowFirst, count: 4 }) };
const WINDOWED_PLAN: SourcePlan = {
  owner: 'windowed',
  entries: [{ name: 'log', source: sourceA, branch: '1', offset: 0, read: { shape: 'paged-rows', tailQuery: { product: 'event-feed-tail', branchId: '1', from: null, limit: 64 }, followQuery: null } }],
};

const DEEP_LOG_TOTAL = 2000;
const DEEP_LOG_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'name', label: 'Event', as: 'plain', offered: ['plain'], priority: 0, text: true },
];
const DEEP_LOG_SETTINGS = tableSettingsOf(undefined, DEEP_LOG_COLUMNS, { density: 'normal', sort: { column: 'name', direction: 'ascending' } });
const DEEP_LOG_OPTIONS = {};
let deepLogHeldRanges: Array<readonly [number, number]> = [];
let deepLogFoldRun: readonly [number, number] | null = null;
let deepLogCommits = 0;

const deepLogProjection = registerFamilyProjection({
  family: 'table',
  kind: 'host-deep-log',
  project(readView): TableModel {
    const win = readView.rowWindow ?? { first: 0, count: 20 };
    const first = Math.max(0, Math.min(DEEP_LOG_TOTAL, win.first));
    const count = Math.max(0, Math.min(DEEP_LOG_TOTAL - first, win.count));
    const slots: TableModelSlot[] = [];
    const rows: TableRow[] = [];
    let foldedEmitted = false;
    for (let i = 0; i < count; i++) {
      const ord = first + i;
      const held = deepLogHeldRanges.some(([lo, hi]) => ord >= lo && ord <= hi);
      if (held) {
        slots.push({ kind: 'loading', key: `loading:${ord}` });
      } else {
        if (deepLogFoldRun && ord >= deepLogFoldRun[0] && ord <= deepLogFoldRun[1]) {
          if (foldedEmitted) continue;
          foldedEmitted = true;
        }
        const row: TableRow = {
          key: `R${ord}`,
          name: `Row ${ord}`,
          cells: { name: { value: { kind: 'known', value: `Row ${ord} h${readView.hour}` } } },
        };
        slots.push({ kind: 'data', row });
        rows.push(row);
      }
    }
    return {
      hour: readView.hour,
      columns: DEEP_LOG_COLUMNS,
      rows,
      slots,
      unsorted: true,
      windowOffset: first,
      totalRows: DEEP_LOG_TOTAL,
    };
  },
});

const NO_EXACT = async () => null;
const NO_SUBSCRIPTIONS: ReturnType<typeof makeSubs> = [];
const BOUNDS: readonly [number, number] = [0, 2000];
const RUNTIME_BY_SOURCE = new Map<DashboardSource, WidgetRuntime>([
  [sourceA, makeRuntime(sourceA)],
  [sourceB, makeRuntime(sourceB)],
]);
function makeIdentity(sourceId: string): IdentitySnapshot {
  return {
    scope: { sourceId, revision: 'r1', branchId: '1', content: 1 },
    branchBounds: [0, 2000],
    facts: {
      branchId: '1',
      known: [[0, 2000]],
      names: ['Germany', 'France', 'Italy', 'United Kingdom'],
      reasons: [],
      flags: [
        { keys: ['GER', null, null], reasons: [null, null, null] },
        { keys: ['FRA', null, null], reasons: [null, null, null] },
        { keys: ['ITA', null, null], reasons: [null, null, null] },
        { keys: ['ENG', null, null], reasons: [null, null, null] },
      ],
      countries: [
        { tag: 'GER', runs: [[0, 0, 0x444444, -1, 0]] },
        { tag: 'FRA', runs: [[0, 1, 0x3366aa, -1, 1]] },
        { tag: 'ITA', runs: [[0, 2, 0x338844, -1, 2]] },
        { tag: 'ENG', runs: [[0, 3, 0xcc4444, -1, 3]] },
      ],
      warnings: [],
    },
    factsFinal: true,
  };
}

const IDENTITY_BY_SOURCE = new Map<DashboardSource, IdentitySnapshot>([
  [sourceA, makeIdentity('camp-A')],
  [sourceB, makeIdentity('camp-B')],
]);

const SUBS_BY_SOURCE = new Map<DashboardSource, ReturnType<typeof makeSubs>>([
  [sourceA, makeSubs(sourceA)],
  [sourceB, makeSubs(sourceB)],
]);

const SPAN_ADAPTER = { ...tableHostAdapter, settings: { resolve: () => SETTINGS } };
const SPAN_DECLARATION = {
  family: 'table',
  kind: 'scoreboard',
  label: 'Span',
  subject: 'span',
  emptyCampaign: 'No campaign',
  countries: { mode: 'none' },
  sources: (ctx: FamilyPlanContext): SourcePlan => ({
    owner: 'span',
    entries: [{
      name: 'unread',
      source: ctx.track.source,
      branch: ctx.branch.id,
      offset: 0,
      read: {
        shape: 'branch-to-hour',
        coverage: { mode: 'population', form: 'all' },
        product: 'span-history' as never,
        followQuery: null,
        params: { branchId: ctx.branch.id },
        buildSpanParams: (params, span) => ({ ...params, hour: span.lastHour }),
        dynamicKeys: ['hour'],
      },
    }],
  }),
  projection: scoreboardProjection,
  projectionOptions: (_ctx: FamilyPlanContext, extra: { readonly extent: readonly [number, number] }) => ({ ...OPTIONS, firstHour: extra.extent[0] }),
};

function renderApp() {
  const rt = RUNTIME_BY_SOURCE.get(currentState.source)!;
  const subs = SUBS_BY_SOURCE.get(currentState.source)!;
  const identity = IDENTITY_BY_SOURCE.get(currentState.source)!;
  const frameCtx = {
    token: currentState.frameToken,
    announce: () => {},
    clearAnnouncement: () => {},
    setSkeleton: () => {},
    reportState: () => {},
    setDynamicViewSwitch: () => {},
  };
  flushSync(() => root!.render(
    <FollowedWidgetKey.Provider value="shared-widget-key">
      <WidgetFrameContext.Provider value={frameCtx as never}>
        <Profiler id="host-dom" onRender={() => { commits++; }}>
          <div data-slot="primary" style={{ width: '460px', height: '240px', display: 'flex', flexDirection: 'column' }}>
            <FamilyHost
              adapter={currentState.windowed ? WINDOWED_ADAPTER : tableHostAdapter}
              {...currentState.windowed ? { plan: WINDOWED_PLAN } : {}}
              chrome={TableChrome}
              view="default"
              declaration={scoreboardProjection}
              options={OPTIONS}
              label="Scoreboard"
              subject="scoreboard"
              widget={widget}
              runtime={rt}
              active={currentState.active}
              settings={currentState.primarySettings}
              subscriptions={subs}
              identitySnapshot={identity}
              exactReadView={NO_EXACT}
              offset={0}
              pin={null}
              bounds={BOUNDS}
              onActivate={action => { activated.push(action.subject); }}
              onTooltipRow={(subject, by) => { tooltipRows.push([by, subject]); if (by === 'pointer') hoverRows.push(subject); }}
              {...currentState.owner ? { owner: currentState.owner } : {}}
            />
          </div>
          {currentState.secondMounted && (
            <div data-slot="secondary" style={{ width: '460px', height: '240px', display: 'flex', flexDirection: 'column' }}>
              <FamilyHost
              adapter={tableHostAdapter}
              chrome={TableChrome}
              view="default"
                declaration={scoreboardProjection}
                options={OPTIONS}
                label="Scoreboard Secondary"
                subject="scoreboard"
                widget={widget}
                runtime={rt}
                active
                settings={SETTINGS}
                subscriptions={subs}
                identitySnapshot={identity}
                exactReadView={NO_EXACT}
                offset={0}
                pin={null}
                bounds={BOUNDS}
              />
            </div>
          )}
          {currentState.genericMounted && (
            <Profiler id="generic-host" onRender={() => { genericCommits++; }}>
              <div data-slot="generic" style={{ width: '460px', height: '240px', display: 'flex', flexDirection: 'column' }}>
                <FamilyHost
                  adapter={hoverRanking ? POINT_HOVER_ADAPTER : currentState.genericListbox ? LISTBOX_ADAPTER : currentState.genericBodyFocus ? BODY_FOCUS_ADAPTER : tableHostAdapter}
                  onHoverHour={(hour, keys) => { hoverReports.push([hour, keys?.main]); }}
                  {...(currentState.genericBodyFocus || currentState.genericListbox ? {} : { chrome: TableChrome })}
                  settings={currentState.genericEmptyToRows ? DEEP_LOG_SETTINGS : SETTINGS}
                  declaration={currentState.genericEmptyToRows ? emptyToRowsProjection : scoreboardProjection}
                  view="default"
                  options={currentState.genericEmptyToRows ? DEEP_LOG_OPTIONS : OPTIONS}
                  label="Scoreboard Generic"
                  subject="scoreboard"
                  widget={widget}
                  runtime={rt}
                  active
                  subscriptions={subs}
                  identitySnapshot={identity}
                  offset={0}
                  pin={null}
                  bounds={BOUNDS}
                  onActivate={action => { genericActivated.push(action); }}
                  onDiagnostics={lines => reportGenericDiagnostics?.(lines)}
                  headerSlot={genericHeader}
                  blockedState={currentState.genericBlocked ? <div data-blocked="true">Not yet</div> : null}
                  keepFollowingWhenBlocked={currentState.genericKeepFollowing}
                  onViewportChange={viewport => { genericViewports.push(viewport.width); }}
                />
              </div>
            </Profiler>
          )}
          {currentState.spanMounted && (
            <div data-slot="span" style={{ width: '460px', height: '240px', display: 'flex', flexDirection: 'column' }}>
              <DeclaredFamilyWidget {...({ adapter: SPAN_ADAPTER, chrome: TableChrome, declaration: SPAN_DECLARATION, widget, options: {}, runtime: rt, active: true } as unknown as DeclaredFamilyWidgetProps)} />
            </div>
          )}
          {currentState.statics && (
            <Profiler id="static-host" onRender={() => { staticCommits++; }}>
              <div data-slot="static" style={{ width: '460px', height: '240px', display: 'flex', flexDirection: 'column' }}>
                <FamilyHost
                  adapter={tableHostAdapter}
                  chrome={TableChrome}
                  settings={SETTINGS}
                  declaration={scoreboardProjection}
                  view="default"
                  options={OPTIONS}
                  label="Scoreboard Static"
                  subject="scoreboard"
                  widget={widget}
                  runtime={rt}
                  active
                  subscriptions={NO_SUBSCRIPTIONS}
                  staticSources={currentState.statics}
                  {...currentState.tiled ? { tiledSeries: currentState.tiled } : {}}
                  {...currentState.hovers ? { hovers: currentState.hovers } : {}}
                  {...currentState.paged ? { pagedRows: currentState.paged } : {}}
                  laneArt={staticArt}
                  identitySnapshot={identity}
                  offset={0}
                  pin={null}
                  bounds={BOUNDS}
                />
              </div>
            </Profiler>
          )}
          {currentState.deepLogMounted && (
            <Profiler id="deep-log-host" onRender={() => { deepLogCommits++; }}>
              <div data-slot="deep-log" style={{ width: '460px', height: '440px', display: 'flex', flexDirection: 'column' }}>
                <FamilyHost
                  adapter={tableHostAdapter}
                  chrome={TableChrome}
                  plan={WINDOWED_PLAN}
                  settings={DEEP_LOG_SETTINGS}
                  declaration={deepLogProjection}
                  view="default"
                  options={DEEP_LOG_OPTIONS}
                  label="Deep Log"
                  subject="deep-log"
                  onTooltipRow={(subject, by) => { if (by === 'focus') deepFocusRows.push(subject); }}
                  widget={widget}
                  runtime={rt}
                  active
                  subscriptions={subs}
                  {...currentState.deepLogPaged ? { pagedRows: currentState.deepLogPaged } : {}}
                  identitySnapshot={identity}
                  offset={0}
                  pin={null}
                  bounds={BOUNDS}
                />
              </div>
            </Profiler>
          )}
          {currentState.pointsMode && (
            <div data-slot="points" style={{ width: '460px', height: '240px', display: 'flex', flexDirection: 'column' }}>
              <FamilyHost
                adapter={timeChartHostAdapter}
                declaration={pointsChartProjection}
                view="default"
                options={POINTS_OPTIONS}
                label="Points Chart"
                subject="points"
                widget={widget}
                runtime={rt}
                active
                subscriptions={NO_SUBSCRIPTIONS}
                staticSources={POINTS_STATICS}
                extent={POINTS_EXTENT}
                identitySnapshot={identity}
                offset={0}
                pin={null}
                bounds={BOUNDS}
                onHoverHour={hour => { pointsHoverHours.push(hour); }}
                {...(currentState.pointsMode === 'pointsNavigate'
                  ? {
                      onPointsNavigate: (req: PointsNavigateRequest) => {
                        pointsNavRequests.push(req);
                        pendingPointsFocusHour = req.focusHour;
                        return true;
                      },
                    }
                  : {})}
              />
            </div>
          )}
          <Profiler id="tooltip-layer" onRender={() => { genericCommits++; }}>
            <TooltipLayer />
          </Profiler>
        </Profiler>
      </WidgetFrameContext.Provider>
    </FollowedWidgetKey.Provider>,
  ));
}

declare global {
  interface Window {
    hostDom: unknown;
  }
}

window.hostDom = {
  async mountPrimary() {
    await document.fonts?.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    renderApp();
    let pipeId = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas');
      if (!canvas?.dataset.placement) return false;
      pipeId = Number(canvas.dataset.placement);
      return pipeId > 0;
    });
    const subs = subsForPipe(pipeId);
    await until(() => subs.length === 2 && subs.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(20);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subs, 20, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeId)?.mode === 'picture' && (container!.querySelectorAll('[data-slot="primary"] table tbody tr').length === 4));
    return { pipeId };
  },

  bodyBox() {
    const box = container!.querySelector<HTMLElement>('[data-slot="primary"] .fh-body')!.getBoundingClientRect();
    return { left: box.left, top: box.top };
  },

  async testF1PinClearsOnCampaignSwitch() {
    const firstRow = container!.querySelector<HTMLTableRowElement>('[data-slot="primary"] table tbody tr')!;
    firstRow.focus();
    const pipeId = Number(container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas')!.dataset.placement);
    await until(() => !!(pipeline.view(pipeId)?.fields?.focusTooltip as { text?: unknown } | undefined)?.text, 2000);
    firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    await until(() => Boolean(tooltipStore.get()?.content.pinned), 2000);
    const pinnedBefore = tooltipStore.get()?.content.title ?? null;

    currentState = { ...currentState, source: sourceB };
    renderApp();
    await until(() => tooltipStore.get() === null, 2000);
    const afterSwitch = tooltipStore.get();

    currentState = { ...currentState, source: sourceA };
    renderApp();
    const nextPipe = Number(container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas')!.dataset.placement);
    const subs = subsForPipe(nextPipe);
    await until(() => subs.length === 2 && subs.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(25);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subs, 25, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(nextPipe)?.mode === 'picture' && !pipeline.view(nextPipe)?.dim);
    return { pinnedBefore, cleared: afterSwitch === null };
  },

  async testF2LeaveThenDeactivateClearsHover() {
    const pipeId = Number(container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas')!.dataset.placement);
    const tipVisible = await until(() => tooltipStore.get() !== null, 2000);
    const bodyEl = container!.querySelector<HTMLElement>('[data-slot="primary"] .fh-body')!;
    bodyEl.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    currentState = { ...currentState, active: false };
    renderApp();
    const afterDeactivate = tooltipStore.get();

    currentState = { ...currentState, active: true };
    renderApp();
    let newPipe = -1;
    await until(() => {
      const c = container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas');
      if (!c?.dataset.placement) return false;
      newPipe = Number(c.dataset.placement);
      return newPipe > 0;
    });
    const subs = subsForPipe(newPipe);
    await until(() => subs.length === 2 && subs.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(30);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subs, 30, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(newPipe)?.mode === 'picture' && !pipeline.view(newPipe)?.dim);
    return { tipVisible, clearedOnDeactivate: afterDeactivate === null, oldPipe: pipeId, newPipe };
  },

  async testFocusRow() {
    const pipeId = Number(container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas')!.dataset.placement);
    const rows = () => [...container!.querySelectorAll<HTMLTableRowElement>('[data-slot="primary"] table tbody tr')];
    const focused = () => tooltipRows.filter(([by]) => by === 'focus').map(([, subject]) => subject);
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    (document.activeElement as HTMLElement | null)?.blur();
    await frames(2);
    tooltipRows.length = 0;
    rows()[0]!.focus();
    await until(() => focused().length === 1, 2000);
    rows()[1]!.focus();
    await until(() => focused().length === 2, 2000);
    const moved = focused();
    const subs = subsForPipe(pipeId);
    const before = focused().length;
    const startHour = clock.getSnapshot().hour;
    const installsBefore = installCalls.get(pipeId) ?? 0;
    await frames(2);
    commits = 0;
    clock.setSpeed(24);
    clock.setPlaying(true);
    const playedFrom = pipeline.view(pipeId)?.id;
    const installsFrom = installCalls.get(pipeId) ?? 0;
    for (let i = 0; i < 12; i++) {
      sendHour(subs, clock.getSnapshot().hour, [90n + BigInt(i), 70n, 50n, 30n]);
      await frames(1);
    }
    await frames(4);
    const playedTo = pipeline.view(pipeId)?.id;
    const installsTo = installCalls.get(pipeId) ?? 0;
    clock.setPlaying(false);
    const playing = { hoursAdvanced: clock.getSnapshot().hour - startHour, installs: (installCalls.get(pipeId) ?? 0) - installsBefore, repainted: playedTo !== undefined && playedTo !== playedFrom && installsTo > installsFrom, calls: focused().length - before, commits };
    clock.seek(clock.getSnapshot().hour + 500);
    seek = clock.getSnapshot().seekSequence;
    const cleared = await until(() => pipeline.view(pipeId)?.mode !== 'picture', 2000);
    await until(() => focused().length > before, 2000);
    const outside = cleared ? focused().slice(before) : ['picture kept'];
    clock.seek(40);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subs, 40, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeId)?.mode === 'picture' && !pipeline.view(pipeId)?.dim);
    rows()[1]!.focus();
    await until(() => focused().at(-1) === 'FRA', 2000);
    const settled = focused().length;
    (document.activeElement as HTMLElement | null)?.blur();
    await until(() => focused().at(-1) === null, 2000);
    return { moved, playing, outside, left: focused().slice(settled) };
  },

  async waitHoverRow(expected: string | null) {
    return until(() => hoverRows.length > 0 && hoverRows[hoverRows.length - 1] === expected, 2000);
  },

  async testHoverRowOwnerReset() {
    const before = hoverRows[hoverRows.length - 1] ?? null;
    currentState = { ...currentState, owner: 'scoreboard-reset' };
    renderApp();
    const cleared = hoverRows[hoverRows.length - 1] ?? null;
    let pipeId = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas');
      pipeId = Number(canvas?.dataset.placement ?? -1);
      return pipeId > 0;
    });
    const subs = subsForPipe(pipeId);
    await until(() => subs.length === 2 && subs.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(35);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subs, 35, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeId)?.mode === 'picture' && !pipeline.view(pipeId)?.dim);
    return { before, cleared, afterInstall: hoverRows[hoverRows.length - 1] ?? null };
  },

  async testF3UnrelatedAppearanceAndF4ReducedMotion() {
    commits = 0;
    bindCount = 0;
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    await nextPoll();
    const unrelatedCommits = commits;
    const unrelatedBinds = bindCount;

    document.documentElement.dataset.motion = 'reduced';
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    await until(() => (lastBoundModel as { reducedMotion?: boolean } | null)?.reducedMotion === true, 2000);
    const bindsAfterToggle = bindCount;
    const boundReduced = (lastBoundModel as { reducedMotion?: boolean } | null)?.reducedMotion === true;

    delete document.documentElement.dataset.motion;
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    await until(() => (lastBoundModel as { reducedMotion?: boolean } | null)?.reducedMotion === false, 2000);
    return { unrelatedCommits, unrelatedBinds, bindsAfterToggle, boundReduced };
  },

  async waitInspected(expectedKey: string) {
    const pipeId = Number(container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas')!.dataset.placement);
    return until(() => {
      const tip = pipeline.view(pipeId)?.fields?.tooltip as { text?: { rowKey?: string } | null } | undefined;
      return tip?.text?.rowKey === expectedKey;
    }, 2000);
  },

  async testF5FrameUpdateDuringPress() {
    activated = [];
    currentState = { ...currentState, frameToken: currentState.frameToken + 1 };
    renderApp();
    return { frameToken: currentState.frameToken };
  },

  async waitActivated() {
    await until(() => activated.length > 0, 2000);
    return [...activated];
  },

  async testGenericHostFrames() {
    hoverRanking = ['NEW', 'OLD'];
    hoverReports.length = 0;
    genericHeader = document.body.appendChild(document.createElement('div'));
    currentState = { ...currentState, genericMounted: true };
    renderApp();
    let pipeG = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="generic"] canvas.fh-canvas');
      if (!canvas?.dataset.placement) return false;
      pipeG = Number(canvas.dataset.placement);
      return pipeG > 0;
    });
    const subsG = subsForPipe(pipeG);
    await until(() => subsG.length === 2 && subsG.every(id => pipeline.status(id).status === 'followed'));
    mirrorMetaOverride = { summaryText: '4 countries', summaryPartial: 'Count from recorded hours' };
    clock.seek(100);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsG, 100, [90n, 70n, 50n, 30n], true);
    const firstPicture = await until(() => pipeline.view(pipeG)?.mode === 'picture' && !pipeline.view(pipeG)?.dim
      && container!.querySelectorAll('[data-slot="generic"] table tbody tr').length === 4);

    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    await frames(4);
    const mountCommits = genericCommits;
    container!.querySelector<HTMLElement>('[data-slot="generic"] table tbody tr')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await frames(4);
    genericCommits = 0;
    bindCount = 0;
    paintsByWidget.set(pipeG, 0);
    clock.setSpeed(24);
    clock.setPlaying(true);
    await frames(2);
    const startCommits = genericCommits;
    const startBinds = bindCount;
    const startPaints = paintsByWidget.get(pipeG) ?? 0;
    await frames(30);
    const quiet = {
      hoursAdvanced: clock.getSnapshot().hour - 100,
      commits: genericCommits - startCommits,
      binds: bindCount - startBinds,
      paints: (paintsByWidget.get(pipeG) ?? 0) - startPaints,
    };

    const steadyStartCommits = genericCommits;
    const steadyStartBinds = bindCount;
    const steadyStartPaints = paintsByWidget.get(pipeG) ?? 0;
    const reported = new Promise<string[]>(resolve => {
      reportGenericDiagnostics = lines => { if (lines.includes('Recorded warning 19')) resolve(lines); };
    });
    let factories = 90n;
    for (let i = 0; i < 20; i++) {
      factories += 5n;
      mirrorMetaOverride = { summaryText: `${i + 4} countries`, summaryPartial: 'Count from recorded hours', warnings: [`Recorded warning ${i}`] };
      hoverRanking = i % 2 ? ['NEW', 'OLD'] : ['OLD', 'NEW'];
      sendHour(subsG, clock.getSnapshot().hour, [factories, 70n, 50n, 30n]);
      await frames(1);
    }
    const diagnosticLines = await reported;
    reportGenericDiagnostics = undefined;
    const steady = {
      commits: genericCommits - steadyStartCommits,
      binds: bindCount - steadyStartBinds,
      paints: (paintsByWidget.get(pipeG) ?? 0) - steadyStartPaints,
      diagnosticLines,
      title: genericHeader.textContent,
    };

    mirrorMetaOverride = { summaryText: '4 countries', summaryPartial: 'Some countries were not recorded' };
    const restoredTitle = waitForPipeInstall(pipeG, () =>
      (pipeline.view(pipeG)?.fields?.meta as { summaryPartial?: string } | undefined)?.summaryPartial === 'Some countries were not recorded');
    sendHour(subsG, clock.getSnapshot().hour, [factories + 1n, 70n, 50n, 30n]);
    await restoredTitle;
    const titleAfterPartialChange = {
      label: genericHeader.textContent,
      tooltip: genericHeader.querySelector('.fh-summary')?.getAttribute('data-tooltip'),
    };

    clock.setPlaying(false);
    await frames(4);
    const settledBinds = bindCount;
    const settledPaints = paintsByWidget.get(pipeG) ?? 0;
    const settledCommits = genericCommits;
    await frames(20);
    const paused = {
      commits: genericCommits - settledCommits,
      binds: bindCount - settledBinds,
      paints: (paintsByWidget.get(pipeG) ?? 0) - settledPaints,
    };

    sendHour(subsG, clock.getSnapshot().hour, [factories, 70n, 50n, 30n]);
    await until(() => pipeline.view(pipeG)?.dim === false && pipeline.view(pipeG)?.h === clock.getSnapshot().hour, 2000);
    genericActivated = [];
    const row = container!.querySelector<HTMLElement>('[data-slot="generic"] table tbody tr')!;
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const installed = pipeline.view(pipeG);
    const activated = genericActivated[0] ?? null;
    hoverRanking = ['NEXT'];
    sendHour(subsG, clock.getSnapshot().hour, [factories + 1n, 70n, 50n, 30n]);
    await until(() => hoverReports.at(-1)?.[1]?.[0] === 'NEXT');
    const rankedHovers = [...hoverReports];
    hoverRanking = null;
    mirrorMetaOverride = null;

    currentState = { ...currentState, genericMounted: false };
    renderApp();
    genericHeader.remove();
    genericHeader = null;
    return {
      firstPicture,
      rankedHovers,
      mountCommits,
      quiet,
      steady,
      titleAfterPartialChange,
      paused,
      activatedSubject: activated?.subject ?? null,
      activatedMatchesInstalled: !!activated && activated.installedId === installed?.id,
    };
  },

  async testGenericStationaryTooltip() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    payloadTips = true;
    currentState = { ...currentState, genericMounted: true };
    renderApp();
    let pipeG = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="generic"] canvas.fh-canvas');
      if (!canvas?.dataset.placement) return false;
      pipeG = Number(canvas.dataset.placement);
      return pipeG > 0;
    });
    const subsG = subsForPipe(pipeG);
    await until(() => subsG.length === 2 && subsG.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(150);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsG, 150, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeG)?.mode === 'picture' && !pipeline.view(pipeG)?.dim
      && container!.querySelectorAll('[data-slot="generic"] table tbody tr').length === 4);
    container!.querySelector<HTMLElement>('[data-slot="generic"] table tbody tr[data-row-key="ENG"]')!.focus();
    const shown = await until(() => tooltipStore.get()?.content.title === 'United Kingdom', 2000);
    await frames(4);

    let storeUpdates = 0;
    const unsubscribe = tooltipStore.subscribe(() => { storeUpdates++; });
    genericCommits = 0;
    const installsBefore = installCalls.get(pipeG) ?? 0;
    for (let i = 0; i < 20; i++) {
      const before = installCalls.get(pipeG);
      sendHour(subsG, 150, [91n + BigInt(i), 70n, 50n, 30n]);
      if (!await until(() => installCalls.get(pipeG) !== before)) throw new Error('The changed Germany row did not install');
    }
    const installs = (installCalls.get(pipeG) ?? 0) - installsBefore;
    const commitsDuring = genericCommits;
    unsubscribe();

    (document.activeElement as HTMLElement | null)?.blur();
    payloadTips = false;
    currentState = { ...currentState, genericMounted: false };
    renderApp();
    return { shown, installs, storeUpdates, commits: commitsDuring };
  },

  async testGenericInstalledTuple() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    genericViewports = [];
    currentState = { ...currentState, genericMounted: true, genericBlocked: true, genericBodyFocus: true };
    renderApp();
    await frames(3);
    const blockedMeasured = genericViewports.some(width => width > 0);
    const blockedShown = !!container!.querySelector('[data-slot="generic"] [data-blocked="true"]');

    currentState = { ...currentState, genericBlocked: false };
    renderApp();
    let pipeG = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="generic"] canvas.fh-canvas');
      if (!canvas?.dataset.placement) return false;
      pipeG = Number(canvas.dataset.placement);
      return pipeG > 0;
    });
    const subsG = subsForPipe(pipeG);
    await until(() => subsG.length === 2 && subsG.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(200);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsG, 200, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeG)?.mode === 'picture' && !pipeline.view(pipeG)?.dim);
    await frames(4);
    const body = container!.querySelector<HTMLElement>('[data-slot="generic"] .fh-body')!;
    const describedBy = body.getAttribute('aria-describedby');
    const description = describedBy ? document.getElementById(describedBy)?.textContent ?? null : null;

    body.focus();
    await frames(2);
    body.blur();
    await frames(2);
    clock.setSpeed(24);
    clock.setPlaying(true);
    for (let i = 0; i < 40; i++) {
      sendHour(subsG, clock.getSnapshot().hour, [90n, 70n, 50n, 30n]);
      await frames(1);
    }
    genericActivated = [];
    body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const view = pipeline.view(pipeG);
    const activated = genericActivated[0] ?? null;

    currentState = { ...currentState, genericBlocked: true, genericKeepFollowing: true };
    renderApp();
    const duringGap = subsForPipe(pipeG);
    const gapShown = !!container!.querySelector('[data-slot="generic"] [data-blocked="true"]');
    genericActivated = [];
    body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const activatedDuringGap = genericActivated.length;
    currentState = { ...currentState, genericBlocked: false, genericKeepFollowing: false };
    renderApp();
    const afterGap = subsForPipe(pipeG);
    const pictureAfterGap = !!container!.querySelector('[data-slot="generic"] [data-family-visible]');
    body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const activatedAfterGap = genericActivated.length - activatedDuringGap;
    clock.setPlaying(false);

    currentState = { ...currentState, genericBlocked: true };
    renderApp();
    await frames(2);
    const clearedDescription = body.getAttribute('aria-describedby') === null;

    currentState = { ...currentState, genericMounted: false, genericBlocked: false, genericBodyFocus: false };
    renderApp();
    return {
      blockedMeasured,
      blockedShown,
      gapShown,
      pictureAfterGap,
      subscriptions: { before: subsG, duringGap, afterGap },
      activatedDuringGap,
      activatedAfterGap,
      description,
      clearedDescription,
      activatedId: activated?.installedId ?? null,
      activatedHour: activated?.hour ?? null,
      viewId: view?.id ?? null,
      viewHour: view?.painted ?? null,
    };
  },

  async testStaticPanelsReplaced() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    const stamped = (round: number): FamilyStaticSources => ({ stamp: {}, proof: null, panels: { unread: { round } }, hour: 40 });
    currentState = { ...currentState, statics: stamped(0) };
    renderApp();
    let pipeS = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="static"] canvas.fh-canvas');
      if (!canvas?.dataset.placement) return false;
      pipeS = Number(canvas.dataset.placement);
      return pipeS > 0;
    });
    await frames(4);
    const generation = pipeline.binding(pipeS);
    staticCommits = 0;
    bindCount = 0;
    staticSupplies = [];
    const rounds = 10;
    for (let round = 1; round <= rounds; round++) {
      currentState = { ...currentState, statics: stamped(round) };
      renderApp();
      await frames(2);
    }
    const result = {
      rounds,
      commits: staticCommits,
      binds: bindCount,
      staticsSupplied: staticSupplies.filter(item => item.id === pipeS && item.statics).length,
      generationKept: pipeline.binding(pipeS) === generation,
      mode: `${pipeline.view(pipeS)?.mode} ${pipeline.view(pipeS)?.reason ?? ''}`,
    };
    currentState = { ...currentState, statics: null };
    renderApp();
    return result;
  },

  async testDataSupplied() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    const tiledLine = (round: number) => ({ tag: 'GER', head: `GER:${round}`, decimals: 0, summary: { from: 0, to: 100 + round, width: 10, buckets: [] }, missing: [], parts: [], marks: null }) as unknown as TiledLine;
    currentState = { ...currentState, statics: { stamp: {}, proof: null, panels: { unread: { round: 0 } }, hour: 40 }, tiled: { main: new Map([['GER', tiledLine(0)]]) } };
    renderApp();
    let pipeS = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="static"] canvas.fh-canvas');
      if (!canvas?.dataset.placement) return false;
      pipeS = Number(canvas.dataset.placement);
      return pipeS > 0;
    });
    await frames(4);
    const generation = pipeline.binding(pipeS);
    bindCount = 0;
    staticSupplies = [];
    const rounds = 10;
    for (let round = 1; round <= rounds; round++) {
      const field = round % 3;
      currentState = field === 1 ? { ...currentState, tiled: { main: new Map([['GER', tiledLine(round)]]) } }
        : field === 2 ? { ...currentState, hovers: { hover: { hour: round, data: { round } } } }
        : { ...currentState, paged: { log: { mark: round } } as unknown as PagedRows };
      renderApp();
      await frames(2);
      staticArt.land({ mark: round } as unknown as ArtResolutions);
      await frames(2);
    }
    const ours = staticSupplies.filter(item => item.id === pipeS && item.statics);
    const result = {
      rounds,
      binds: bindCount,
      supplies: ours.length,
      tilesSupplied: [...new Set(ours.map(item => item.tiledHead ?? null))],
      hoursSupplied: [...new Set(ours.map(item => item.hoverHour ?? null))],
      pagesSupplied: [...new Set(ours.map(item => item.paged ?? null))],
      artSupplied: [...new Set(ours.map(item => item.art ?? null))].filter(mark => mark !== null),
      generationKept: pipeline.binding(pipeS) === generation,
    };
    currentState = { ...currentState, statics: null, tiled: undefined, hovers: undefined, paged: undefined };
    renderApp();
    return result;
  },

  async testRowWindowCorrected() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    windowFirst = 0;
    currentState = { ...currentState, windowed: true };
    renderApp();
    const pipeP = Number(container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas')!.dataset.placement);
    const bodyP = container!.querySelector<HTMLElement>('[data-slot="primary"] .fh-body')!;
    bodyP.style.overflowY = 'scroll';
    bodyP.style.flex = 'none';
    bodyP.style.height = `${bodyP.clientHeight}px`;
    const subs = subsForPipe(pipeP);
    const hour = 600;
    clock.seek(hour);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subs, hour, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeP)?.h === hour);
    await frames(4);
    const generation = pipeline.binding(pipeP);
    boundIds = [];
    const windows: unknown[] = [];
    const rounds = 5;
    for (let round = 1; round <= rounds; round++) {
      windowFirst = round * 10;
      sendHour(subs, hour, [BigInt(90 + round), 70n, 50n, 30n], true);
      await until(() => ((lastViewWindow.get(pipeP) as { first?: number } | undefined)?.first ?? -1) === round * 10);
      windows.push(lastViewWindow.get(pipeP));
    }
    const result = { rounds, binds: boundIds.filter(id => id === pipeP).length, generationKept: pipeline.binding(pipeP) === generation, windows };
    bodyP.style.overflowY = '';
    bodyP.style.flex = '';
    bodyP.style.height = '';
    currentState = { ...currentState, windowed: false };
    renderApp();
    await frames(2);
    return result;
  },

  async testSpanEndOnly() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    clock.setPlaying(false);
    clock.seek(300);
    currentState = { ...currentState, spanMounted: true };
    renderApp();
    let pipeS = -1;
    await until(() => {
      const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="span"] canvas.fh-canvas');
      if (!canvas?.dataset.placement) return false;
      pipeS = Number(canvas.dataset.placement);
      return pipeS > 0;
    });
    await until(() => staticSupplies.some(item => item.id === pipeS && item.statics));
    await frames(4);
    boundIds = [];
    staticSupplies = [];
    const from = clock.getSnapshot().hour;
    clock.setSpeed(24);
    clock.setPlaying(true);
    await frames(60);
    const result = {
      hoursAdvanced: clock.getSnapshot().hour - from,
      answers: staticSupplies.filter(item => item.id === pipeS && item.statics).length,
      binds: boundIds.filter(id => id === pipeS).length,
      mode: `${pipeline.view(pipeS)?.mode} ${pipeline.view(pipeS)?.reason ?? ''}`,
    };
    clock.setPlaying(false);
    await frames(4);
    currentState = { ...currentState, spanMounted: false };
    renderApp();
    return result;
  },

  async testF12DualPlacementAndTypeahead() {
    currentState = { ...currentState, secondMounted: true };
    renderApp();
    let pipeA = -1;
    let pipeB = -1;
    await until(() => {
      const cA = container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas');
      const cB = container!.querySelector<HTMLCanvasElement>('[data-slot="secondary"] canvas.fh-canvas');
      if (!cA?.dataset.placement || !cB?.dataset.placement) return false;
      pipeA = Number(cA.dataset.placement);
      pipeB = Number(cB.dataset.placement);
      return pipeA > 0 && pipeB > 0;
    });
    const cA = container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas')!;
    const cB = container!.querySelector<HTMLCanvasElement>('[data-slot="secondary"] canvas.fh-canvas')!;
    const distinctCanvases = cA !== cB;
    const distinctPlacements = pipeA !== pipeB;
    const readers = (perf as unknown as { readers: Map<string, unknown> }).readers;
    const hasReaderA = readers.has(`${pipeline.generation}/${pipeA}/-1`);
    const hasReaderB = readers.has(`${pipeline.generation}/${pipeB}/-1`);

    const subsB = subsForPipe(pipeB);
    await until(() => subsB.length === 2 && subsB.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(35);
    seek = clock.getSnapshot().seekSequence;
    sendHour([...subsForPipe(pipeA), ...subsB], 35, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeB)?.h === 35 && pipeline.view(pipeA)?.h === 35);

    currentState = { ...currentState, secondMounted: false };
    renderApp();
    await nextPoll();
    const subsA = subsForPipe(pipeA);
    clock.seek(36);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsA, 36, [95n, 70n, 50n, 30n], true);
    const primaryStillInstalls = await until(() => pipeline.view(pipeA)?.h === 36 && !pipeline.view(pipeA)?.dim, 2000);

    const firstRow = container!.querySelector<HTMLTableRowElement>('[data-slot="primary"] table tbody tr')!;
    firstRow.focus();
    firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
    const typeaheadKey = await until(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key') === 'ITA', 2000)
      ? (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key')
      : null;

    return { distinctCanvases, distinctPlacements, hasReaderA, hasReaderB, primaryStillInstalls, typeaheadKey };
  },

  async testDeepLogHomeEnd() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    let pageSeq = 1;
    const releasePages = () => {
      deepLogHeldRanges = [];
      currentState = { ...currentState, deepLogPaged: { log: { mark: pageSeq++ } } as unknown as PagedRows };
      renderApp();
    };
    deepLogHeldRanges = [];
    currentState = { ...currentState, deepLogMounted: true, deepLogPaged: { log: { mark: pageSeq++ } } as unknown as PagedRows };
    renderApp();
    let pipeD = -1;
    await until(() => {
      const c = container!.querySelector<HTMLCanvasElement>('[data-slot="deep-log"] canvas.fh-canvas');
      if (!c?.dataset.placement) return false;
      pipeD = Number(c.dataset.placement);
      return pipeD > 0;
    });
    const subsD = subsForPipe(pipeD);
    await until(() => subsD.length === 2 && subsD.every(id => pipeline.status(id).status === 'followed'));
    clock.setPlaying(false);
    clock.seek(400);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsD, 400, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeD)?.mode === 'picture' && !pipeline.view(pipeD)?.dim
      && !!container!.querySelector('[data-slot="deep-log"] table tbody tr[data-row-key="R0"]'));

    const bodyD = container!.querySelector<HTMLElement>('[data-slot="deep-log"] .fh-body')!;
    const tableD = container!.querySelector<HTMLTableElement>('[data-slot="deep-log"] table')!;
    const scrollToRow = async (ord: number) => {
      bodyD.scrollTop = ord * ROW_HEIGHT.normal;
      bodyD.dispatchEvent(new Event('scroll'));
      await until(() => !!container!.querySelector(`[data-slot="deep-log"] table tbody tr[data-row-key="R${ord}"]`), 3000);
      await frames(2);
    };
    const rowEl = (ord: number) => container!.querySelector<HTMLTableRowElement>(`[data-slot="deep-log"] table tbody tr[data-row-key="R${ord}"]`);
    const activeInfo = () => {
      const el = document.activeElement as HTMLElement | null;
      return { key: el?.getAttribute('data-row-key') ?? null, rowIndex: el?.getAttribute('aria-rowindex') ?? null };
    };

    await scrollToRow(610);
    const deepRowCount = tableD.getAttribute('aria-rowcount');
    const deepRowIndex = rowEl(610)?.getAttribute('aria-rowindex') ?? null;
    rowEl(610)!.focus();
    await frames(2);
    await until(() => deepFocusRows.at(-1) === 'R610', 2000);
    deepFocusRows.length = 0;

    deepLogHeldRanges = [[0, 30]];
    boundIds = [];
    const homeGen = pipeline.binding(pipeD);
    rowEl(610)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const homeScrolled = await until(() => bodyD.scrollTop === 0 && !!container!.querySelector('[data-slot="deep-log"] table tbody tr[data-row-key="loading:0"]'), 2000);
    await frames(2);
    const homeParked = [...deepFocusRows];
    const homeScrollBinds = boundIds.filter(id => id === pipeD).length;
    const homeScrollKeptGen = pipeline.binding(pipeD) === homeGen;
    releasePages();
    const homeArrived = await until(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key') === 'R0', 2000);
    const homeFocusRows = [...deepFocusRows];
    const homeActive = activeInfo();

    await scrollToRow(610);
    rowEl(610)!.focus();
    await frames(2);

    deepLogHeldRanges = [[DEEP_LOG_TOTAL - 30, DEEP_LOG_TOTAL - 1]];
    boundIds = [];
    const endGen = pipeline.binding(pipeD);
    rowEl(610)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const endScrolled = await until(() => bodyD.scrollTop > 610 * ROW_HEIGHT.normal && !!container!.querySelector(`[data-slot="deep-log"] table tbody tr[data-row-key="loading:${DEEP_LOG_TOTAL - 1}"]`), 2000);
    await frames(2);
    const endScrollBinds = boundIds.filter(id => id === pipeD).length;
    const endScrollKeptGen = pipeline.binding(pipeD) === endGen;
    releasePages();
    const endArrived = await until(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key') === `R${DEEP_LOG_TOTAL - 1}`, 2000);
    const endActive = activeInfo();

    await scrollToRow(610);
    rowEl(610)!.focus();
    await frames(2);
    deepLogHeldRanges = [[DEEP_LOG_TOTAL - 30, DEEP_LOG_TOTAL - 1]];
    rowEl(610)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const scrollCancelLoaded = await until(() => bodyD.scrollTop > 610 * ROW_HEIGHT.normal && !!container!.querySelector(`[data-slot="deep-log"] table tbody tr[data-row-key="loading:${DEEP_LOG_TOTAL - 1}"]`), 2000);
    bodyD.scrollTop = (DEEP_LOG_TOTAL - 15) * ROW_HEIGHT.normal;
    bodyD.dispatchEvent(new Event('scroll'));
    await frames(2);
    releasePages();
    const scrollCancelArrived = await until(() => !!rowEl(DEEP_LOG_TOTAL - 1), 2000);
    await frames(4);
    const scrollCancelKey = activeInfo().key;

    await scrollToRow(610);
    rowEl(610)!.focus();
    await frames(2);
    deepLogHeldRanges = [[DEEP_LOG_TOTAL - 30, DEEP_LOG_TOTAL - 1]];
    rowEl(610)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const keyCancelLoaded = await until(() => bodyD.scrollTop > 610 * ROW_HEIGHT.normal && !!container!.querySelector(`[data-slot="deep-log"] table tbody tr[data-row-key="loading:${DEEP_LOG_TOTAL - 1}"]`), 2000);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    releasePages();
    const keyCancelArrived = await until(() => !!rowEl(DEEP_LOG_TOTAL - 1), 2000);
    await frames(4);
    const keyCancelKey = activeInfo().key;

    await scrollToRow(610);
    rowEl(610)!.focus();
    await frames(2);
    deepLogHeldRanges = [[DEEP_LOG_TOTAL - 30, DEEP_LOG_TOTAL - 1]];
    rowEl(610)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const endUpLoaded = await until(() => bodyD.scrollTop > 610 * ROW_HEIGHT.normal && !!container!.querySelector(`[data-slot="deep-log"] table tbody tr[data-row-key="loading:${DEEP_LOG_TOTAL - 1}"]`), 2000);
    const endUpParkedTag = (document.activeElement as HTMLElement | null)?.tagName ?? null;
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    releasePages();
    const endUpArrived = await until(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key') === `R${DEEP_LOG_TOTAL - 2}`, 2000);
    const endUpActive = activeInfo();

    await scrollToRow(610);
    const visibleCount = Math.floor(bodyD.clientHeight / ROW_HEIGHT.normal);
    const bottomVisible = 610 + visibleCount - 1;
    rowEl(bottomVisible)!.focus();
    await frames(2);
    const expectedPageDown = bottomVisible + Math.max(1, visibleCount - 1);
    rowEl(bottomVisible)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    const pageDownArrived = await until(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key') === `R${expectedPageDown}`, 2000);
    const pageDownActive = activeInfo();

    await scrollToRow(610);
    rowEl(610)!.focus();
    await frames(2);
    deepLogFoldRun = [DEEP_LOG_TOTAL - 30, DEEP_LOG_TOTAL - 3];
    deepLogHeldRanges = [[DEEP_LOG_TOTAL - 30, DEEP_LOG_TOTAL - 1]];
    rowEl(610)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const foldedLoaded = await until(() => bodyD.scrollTop > 610 * ROW_HEIGHT.normal && !!container!.querySelector(`[data-slot="deep-log"] table tbody tr[data-row-key="loading:${DEEP_LOG_TOTAL - 1}"]`), 2000);
    const foldedGenBefore = pipeline.binding(pipeD);
    releasePages();
    const foldedArrived = await until(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-row-key') === `R${DEEP_LOG_TOTAL - 1}`, 2000);
    const foldedBindSettled = await until(() => {
      const gen = pipeline.binding(pipeD);
      const view = pipeline.view(pipeD);
      return gen > foldedGenBefore && view?.installedBinding === gen;
    }, 2000);
    await frames(4);
    const foldedActive = activeInfo();
    const foldedUpGenBefore = pipeline.binding(pipeD);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const foldedUpSettled = await until(() => {
      const gen = pipeline.binding(pipeD);
      const view = pipeline.view(pipeD);
      return gen > foldedUpGenBefore && view?.installedBinding === gen;
    }, 2000);
    await frames(4);
    const foldedUpActive = activeInfo();
    deepLogFoldRun = null;

    await scrollToRow(610);
    rowEl(610)!.focus();
    await frames(4);
    deepLogCommits = 0;
    boundIds = [];
    paintsByWidget.set(pipeD, 0);
    clock.setSpeed(24);
    clock.setPlaying(true);
    let fac = 90n;
    for (let i = 0; i < 20; i++) {
      fac += 5n;
      sendHour(subsD, clock.getSnapshot().hour, [fac, 70n, 50n, 30n]);
      await frames(1);
    }
    await frames(4);
    const playCommits = deepLogCommits;
    const playBinds = boundIds.filter(id => id === pipeD).length;
    const playPaints = paintsByWidget.get(pipeD) ?? 0;
    clock.setPlaying(false);
    await frames(2);

    deepLogHeldRanges = [];
    deepLogFoldRun = null;
    currentState = { ...currentState, deepLogMounted: false, deepLogPaged: undefined };
    renderApp();
    await frames(2);
    return {
      homeParked,
      homeFocusRows,
      deepRowCount,
      deepRowIndex,
      homeScrolled,
      homeScrollBinds,
      homeScrollKeptGen,
      homeArrived,
      homeActive,
      endScrolled,
      endScrollBinds,
      endScrollKeptGen,
      endArrived,
      endActive,
      scrollCancelLoaded,
      scrollCancelArrived,
      scrollCancelKey,
      keyCancelLoaded,
      keyCancelArrived,
      keyCancelKey,
      endUpLoaded,
      endUpParkedTag,
      endUpArrived,
      endUpActive,
      expectedPageDown,
      pageDownArrived,
      pageDownActive,
      foldedLoaded,
      foldedArrived,
      foldedBindSettled,
      foldedActive,
      foldedUpSettled,
      foldedUpActive,
      playCommits,
      playBinds,
      playPaints,
    };
  },

  async testDeferredScreenReaderMirrors() {
    const frames = async (count: number) => {
      for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    clock.setPlaying(false);
    (document.activeElement as HTMLElement | null)?.blur();
    currentState = { ...currentState, secondMounted: true };
    renderApp();
    let pipeA = -1;
    let pipeB = -1;
    await until(() => {
      const cA = container!.querySelector<HTMLCanvasElement>('[data-slot="primary"] canvas.fh-canvas');
      const cB = container!.querySelector<HTMLCanvasElement>('[data-slot="secondary"] canvas.fh-canvas');
      if (!cA?.dataset.placement || !cB?.dataset.placement) return false;
      pipeA = Number(cA.dataset.placement);
      pipeB = Number(cB.dataset.placement);
      return pipeA > 0 && pipeB > 0;
    });
    const subsA = subsForPipe(pipeA);
    const subsB = subsForPipe(pipeB);
    await until(() => subsA.length === 2 && subsB.length === 2
      && [...subsA, ...subsB].every(id => pipeline.status(id).status === 'followed'));
    const allSubs = [...subsA, ...subsB];
    mirrorMetaOverride = { summaryText: 'Base summary', summaryPartial: null };
    clock.seek(50);
    seek = clock.getSnapshot().seekSequence;
    sendHour(allSubs, 50, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeA)?.h === 50 && !pipeline.view(pipeA)?.dim
      && pipeline.view(pipeB)?.h === 50 && !pipeline.view(pipeB)?.dim);
    await frames(4);

    const tableA = container!.querySelector<HTMLTableElement>('[data-slot="primary"] table')!;
    const tableB = container!.querySelector<HTMLTableElement>('[data-slot="secondary"] table')!;
    const topKey = (table: HTMLTableElement) => table.querySelector<HTMLTableRowElement>('tbody tr')?.dataset.rowKey ?? null;
    const headLabels = (table: HTMLTableElement) => [...table.querySelectorAll<HTMLTableCellElement>('thead th')].map(th => th.textContent ?? '');
    const rowCellCount = (table: HTMLTableElement) => table.querySelector<HTMLTableRowElement>('tbody tr')?.children.length ?? 0;
    const pre = {
      hourA: tableA.getAttribute('data-mirror-hour'),
      hourB: tableB.getAttribute('data-mirror-hour'),
      heldA: tableA.getAttribute('data-held'),
      heldB: tableB.getAttribute('data-held'),
      topA: topKey(tableA),
      topB: topKey(tableB),
      captionA: tableA.caption?.textContent ?? null,
      headCountA: headLabels(tableA).length,
      cellCountA: rowCellCount(tableA),
    };

    const watch = (table: HTMLTableElement) => {
      let content = 0;
      let holdAttrs = 0;
      const observer = new MutationObserver(records => {
        for (const rec of records) {
          if (rec.target === table && rec.type === 'attributes' && (rec.attributeName === 'data-held' || rec.attributeName === 'aria-busy')) {
            holdAttrs++;
          } else {
            content++;
          }
        }
      });
      observer.observe(table, { subtree: true, childList: true, characterData: true, attributes: true });
      return {
        get content() { return content; },
        get holdAttrs() { return holdAttrs; },
        reset() { observer.takeRecords(); content = 0; holdAttrs = 0; },
        stop() { observer.disconnect(); },
      };
    };

    const watchA = watch(tableA);
    const watchB = watch(tableB);
    const installsBeforeA = installCalls.get(pipeA) ?? 0;
    const installsBeforeB = installCalls.get(pipeB) ?? 0;

    clock.setSpeed(24);
    clock.setPlaying(true);
    mirrorMetaOverride = { summaryText: 'Live summary', summaryPartial: 'Partial during playback' };
    currentState = {
      ...currentState,
      primarySettings: {
        ...SETTINGS,
        columns: { ...SETTINGS.columns, casualties: { ...SETTINGS.columns.casualties!, show: false } },
      },
    };
    renderApp();
    for (let i = 1; i <= 16; i++) {
      const h = clock.getSnapshot().hour;
      sendHour(allSubs, h, [10n, 20n, 30n, 200n + BigInt(i * 10)]);
      await frames(1);
    }
    await frames(4);
    const played = {
      installsA: (installCalls.get(pipeA) ?? 0) - installsBeforeA,
      installsB: (installCalls.get(pipeB) ?? 0) - installsBeforeB,
      viewHourA: pipeline.view(pipeA)?.h ?? null,
      viewHourB: pipeline.view(pipeB)?.h ?? null,
      contentA: watchA.content,
      contentB: watchB.content,
      holdAttrsA: watchA.holdAttrs,
      holdAttrsB: watchB.holdAttrs,
      heldA: tableA.getAttribute('data-held'),
      heldB: tableB.getAttribute('data-held'),
      busyA: tableA.getAttribute('aria-busy'),
      busyB: tableB.getAttribute('aria-busy'),
      hourA: tableA.getAttribute('data-mirror-hour'),
      hourB: tableB.getAttribute('data-mirror-hour'),
      topA: topKey(tableA),
      topB: topKey(tableB),
      captionA: tableA.caption?.textContent ?? null,
      captionB: tableB.caption?.textContent ?? null,
      headCountA: headLabels(tableA).length,
      cellCountA: rowCellCount(tableA),
    };

    watchA.reset();
    watchB.reset();
    tableA.querySelector<HTMLTableRowElement>('tbody tr')!.focus();
    await until(() => tableA.getAttribute('data-held') === null && topKey(tableA) === 'ENG', 2000);
    await frames(2);
    const focusedNow = {
      heldA: tableA.getAttribute('data-held'),
      busyA: tableA.getAttribute('aria-busy'),
      hourA: tableA.getAttribute('data-mirror-hour'),
      viewHourA: String(pipeline.view(pipeA)?.h ?? ''),
      topA: topKey(tableA),
      heldB: tableB.getAttribute('data-held'),
      busyB: tableB.getAttribute('aria-busy'),
      hourB: tableB.getAttribute('data-mirror-hour'),
      topB: topKey(tableB),
      contentB: watchB.content,
    };

    for (let i = 1; i <= 6; i++) {
      const h = clock.getSnapshot().hour;
      sendHour(allSubs, h, [10n, 20n, 500n + BigInt(i * 10), 40n]);
      await frames(1);
    }
    await frames(4);
    const whileFocused = {
      topA: topKey(tableA),
      heldA: tableA.getAttribute('data-held'),
      hourA: tableA.getAttribute('data-mirror-hour'),
      contentB: watchB.content,
      topB: topKey(tableB),
      heldB: tableB.getAttribute('data-held'),
      hourB: tableB.getAttribute('data-mirror-hour'),
    };

    (document.activeElement as HTMLElement | null)?.blur();
    await frames(2);
    clock.seek(180);
    seek = clock.getSnapshot().seekSequence;
    sendHour(allSubs, 180, [10n, 600n, 20n, 30n], true);
    await until(() => pipeline.view(pipeA)?.h === 180 && !pipeline.view(pipeA)?.dim
      && pipeline.view(pipeB)?.h === 180 && !pipeline.view(pipeB)?.dim, 2000);
    await frames(2);
    const afterSeek = {
      hourA: tableA.getAttribute('data-mirror-hour'),
      hourB: tableB.getAttribute('data-mirror-hour'),
      heldA: tableA.getAttribute('data-held'),
      heldB: tableB.getAttribute('data-held'),
      topA: topKey(tableA),
      topB: topKey(tableB),
    };

    watchA.reset();
    watchB.reset();
    clock.setPlaying(true);
    let sentThrough = 180;
    const feedGer = (target: number) => {
      while (sentThrough < target) {
        sentThrough++;
        sendHour(allSubs, sentThrough, [900n + BigInt(sentThrough - 180) * 10n, 20n, 30n, 40n]);
      }
    };
    for (let i = 1; i <= 12; i++) {
      feedGer(clock.getSnapshot().hour + 2);
      await frames(1);
    }
    feedGer(clock.getSnapshot().hour + 4);
    await frames(4);
    const afterSeekPlayed = {
      contentA: watchA.content,
      contentB: watchB.content,
      heldA: tableA.getAttribute('data-held'),
      heldB: tableB.getAttribute('data-held'),
      hourA: tableA.getAttribute('data-mirror-hour'),
      hourB: tableB.getAttribute('data-mirror-hour'),
    };

    currentState = { ...currentState, owner: 'mirror-owner-midplay' };
    renderApp();
    const afterOwnerClear = {
      tabIndexA: tableA.tabIndex,
      hourA: tableA.getAttribute('data-mirror-hour'),
      rowsA: tableA.querySelectorAll('tbody tr').length,
    };
    await until(() => {
      feedGer(clock.getSnapshot().hour + 2);
      return tableA.getAttribute('data-mirror-hour') !== null && tableA.querySelectorAll('tbody tr').length === 4;
    }, 2000);
    const afterOwnerRecover = {
      tabIndexA: tableA.tabIndex,
      hourA: tableA.getAttribute('data-mirror-hour'),
      topA: topKey(tableA),
      rowsA: tableA.querySelectorAll('tbody tr').length,
    };

    feedGer(clock.getSnapshot().hour + 2);
    clock.setPlaying(false);
    await until(() => tableA.getAttribute('data-held') === null && tableB.getAttribute('data-held') === null, 2000);
    await frames(2);
    const paused = {
      heldA: tableA.getAttribute('data-held'),
      heldB: tableB.getAttribute('data-held'),
      busyA: tableA.getAttribute('aria-busy'),
      busyB: tableB.getAttribute('aria-busy'),
      hourA: tableA.getAttribute('data-mirror-hour'),
      hourB: tableB.getAttribute('data-mirror-hour'),
      viewHourA: String(pipeline.view(pipeA)?.h ?? ''),
      viewHourB: String(pipeline.view(pipeB)?.h ?? ''),
      topA: topKey(tableA),
      topB: topKey(tableB),
      captionA: tableA.caption?.textContent ?? null,
      captionB: tableB.caption?.textContent ?? null,
      headCountA: headLabels(tableA).length,
      cellCountA: rowCellCount(tableA),
    };

    watchA.stop();
    watchB.stop();

    currentState = { ...currentState, secondMounted: false, owner: undefined, primarySettings: SETTINGS, genericMounted: true, genericListbox: true, genericEmptyToRows: false };
    mirrorMetaOverride = { summaryText: 'Listbox summary', summaryPartial: null };
    renderApp();
    let pipeLb = -1;
    await until(() => {
      const c = container!.querySelector<HTMLCanvasElement>('[data-slot="generic"] canvas.fh-canvas');
      pipeLb = Number(c?.dataset.placement ?? -1);
      return pipeLb > 0;
    });
    const subsLb = subsForPipe(pipeLb);
    await until(() => subsLb.length === 2 && subsLb.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(50);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsLb, 50, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeLb)?.h === 50 && !pipeline.view(pipeLb)?.dim);
    await frames(2);
    const lbEl = container!.querySelector<HTMLDivElement>('[data-slot="generic"] .fh-sr-only')!;
    clock.setSpeed(1);
    clock.setPlaying(true);
    pipeline.pointer(pipeLb, 0, [40, 14]);
    await frames(4);
    const listboxSameHour = {
      held: lbEl.getAttribute('data-held'),
      busy: lbEl.getAttribute('aria-busy'),
      hour: lbEl.getAttribute('data-mirror-hour'),
    };
    clock.setPlaying(false);
    await frames(2);

    mirrorMetaOverride = null;
    currentState = { ...currentState, genericMounted: false, genericListbox: false, genericEmptyToRows: false };
    renderApp();
    await frames(2);
    currentState = { ...currentState, genericMounted: true, genericListbox: false, genericEmptyToRows: true };
    renderApp();
    let pipeCoalesced = -1;
    await until(() => {
      const c = container!.querySelector<HTMLCanvasElement>('[data-slot="generic"] canvas.fh-canvas');
      pipeCoalesced = Number(c?.dataset.placement ?? -1);
      return pipeCoalesced > 0;
    });
    const subsCoalesced = subsForPipe(pipeCoalesced);
    await until(() => subsCoalesced.length === 2 && subsCoalesced.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(50);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsCoalesced, 50, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeCoalesced)?.h === 50 && !pipeline.view(pipeCoalesced)?.dim);
    await frames(2);
    const coalescedTable = container!.querySelector<HTMLTableElement>('[data-slot="generic"] table')!;
    const coalescedEmpty = {
      rows: coalescedTable.querySelectorAll('tbody tr').length,
      tabIndex: coalescedTable.tabIndex,
    };
    dropNextPopulatedMirror = true;
    clock.setSpeed(24);
    clock.setPlaying(true);
    let coalescedSent = 50;
    const recoveredCoalesced = await until(() => {
      while (coalescedSent < clock.getSnapshot().hour + 2) {
        coalescedSent++;
        sendHour(subsCoalesced, coalescedSent, [90n, 70n, 50n, 30n]);
      }
      return coalescedTable.querySelectorAll('tbody tr').length === 1;
    }, 2000);
    const coalescedAfter = {
      recovered: recoveredCoalesced,
      dropped: !dropNextPopulatedMirror,
      rows: coalescedTable.querySelectorAll('tbody tr').length,
      tabIndex: coalescedTable.tabIndex,
      text: coalescedTable.querySelector('tbody tr td')?.textContent ?? '',
    };
    clock.setPlaying(false);
    dropNextPopulatedMirror = false;
    currentState = { ...currentState, genericMounted: false, genericListbox: false, genericEmptyToRows: false };
    renderApp();
    await frames(2);

    currentState = { ...currentState, genericMounted: true, genericListbox: false, genericEmptyToRows: false };
    renderApp();
    let pipeEdge = -1;
    await until(() => {
      const c = container!.querySelector<HTMLCanvasElement>('[data-slot="generic"] canvas.fh-canvas');
      pipeEdge = Number(c?.dataset.placement ?? -1);
      return pipeEdge > 0;
    });
    const subsEdge = subsForPipe(pipeEdge);
    await until(() => subsEdge.length === 2 && subsEdge.every(id => pipeline.status(id).status === 'followed'));
    clock.seek(50);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsEdge, 50, [90n, 70n, 50n, 30n], true);
    await until(() => pipeline.view(pipeEdge)?.h === 50 && !pipeline.view(pipeEdge)?.dim);
    await frames(2);
    const edgeTable = container!.querySelector<HTMLTableElement>('[data-slot="generic"] table')!;
    let minRowsDuringPause = edgeTable.querySelectorAll('tbody tr').length;
    let minHeadsDuringPause = edgeTable.querySelectorAll('thead th').length;
    const pauseObs = new MutationObserver(() => {
      minRowsDuringPause = Math.min(minRowsDuringPause, edgeTable.querySelectorAll('tbody tr').length);
      minHeadsDuringPause = Math.min(minHeadsDuringPause, edgeTable.querySelectorAll('thead th').length);
    });
    pauseObs.observe(edgeTable, { subtree: true, childList: true });
    const installsBeforeOmit = installCalls.get(pipeEdge) ?? 0;
    dropNextPopulatedMirror = true;
    sendHour(subsEdge, 50, [111n, 70n, 50n, 30n]);
    await until(() => (installCalls.get(pipeEdge) ?? 0) > installsBeforeOmit, 2000);
    await frames(2);
    pauseObs.disconnect();
    const pausedOmitted = {
      dropped: !dropNextPopulatedMirror,
      minRows: minRowsDuringPause,
      minHeads: minHeadsDuringPause,
      held: edgeTable.getAttribute('data-held'),
      hour: edgeTable.getAttribute('data-mirror-hour'),
    };

    dropNextPopulatedMirror = true;
    clock.seek(180);
    seek = clock.getSnapshot().seekSequence;
    sendHour(subsEdge, 180, [10n, 600n, 20n, 30n], true);
    clock.setSpeed(24);
    clock.setPlaying(true);
    let seekSent = 180;
    const recoveredSeek = await until(() => {
      while (seekSent < clock.getSnapshot().hour + 2) {
        seekSent++;
        sendHour(subsEdge, seekSent, [10n, 600n + BigInt(seekSent - 180), 20n, 30n]);
      }
      return edgeTable.getAttribute('data-held') === null && topKey(edgeTable) === 'FRA';
    }, 2000);
    const coalescedSeek = {
      recovered: recoveredSeek,
      dropped: !dropNextPopulatedMirror,
      held: edgeTable.getAttribute('data-held'),
      top: topKey(edgeTable),
      hour: Number(edgeTable.getAttribute('data-mirror-hour') ?? '0'),
    };
    clock.setPlaying(false);
    dropNextPopulatedMirror = false;
    currentState = { ...currentState, genericMounted: false, genericListbox: false, genericEmptyToRows: false };
    renderApp();
    await frames(2);
    return { pre, played, focusedNow, whileFocused, afterSeek, afterSeekPlayed, afterOwnerClear, afterOwnerRecover, paused, listboxSameHour, coalescedEmpty, coalescedAfter, pausedOmitted, coalescedSeek };
  },

  async mountPointsHost(mode: 'focusKey' | 'pointsNavigate') {
    holdHitsForPipe = null;
    heldHits.length = 0;
    pointsHoverHours.length = 0;
    pointsNavRequests.length = 0;
    pendingPointsFocusHour = null;
    (document.activeElement as HTMLElement | null)?.blur();

    currentState = { ...currentState, pointsMode: mode };
    renderApp();
    const canvas = container!.querySelector<HTMLCanvasElement>('[data-slot="points"] canvas.fh-canvas')!;
    const pipeId = Number(canvas.dataset.placement);
    await waitForPipeInstall(pipeId, () => {
      const view = pipeline.view(pipeId);
      const meta = view?.fields?.meta as { readonly plotRect?: unknown; readonly transform?: unknown } | undefined;
      return view?.mode === 'picture' && !view.dim && !!meta?.plotRect && !!meta?.transform;
    });
    await waitAnimationFrames(1);

    const view = pipeline.view(pipeId)!;
    const meta = view.fields!.meta as {
      readonly plotRect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
      readonly transform: { readonly xFrom: number; readonly xTo: number };
    };
    const rect = canvas.getBoundingClientRect();
    const vp = view.viewport!;
    const localX = meta.plotRect.left + ((12 - meta.transform.xFrom) / (meta.transform.xTo - meta.transform.xFrom)) * meta.plotRect.width;
    const localY = meta.plotRect.top + Math.min(12, meta.plotRect.height / 4);
    const hour12Point = {
      x: Math.round(rect.left + localX * (rect.width / vp.width)),
      y: Math.round(rect.top + localY * (rect.height / vp.height)),
    };
    const navKeys = ((view.fields?.nav as readonly (readonly [string, ...unknown[]])[] | undefined) ?? []).map(entry => entry[0]);

    const body = container!.querySelector<HTMLElement>('[data-slot="points"] .fh-body')!;
    body.focus();
    if (mode === 'focusKey') {
      await waitForTooltipSubtitle(formatDateHover(0));
    } else {
      await waitAnimationFrames(2);
    }

    pointsHoverHours.length = 0;
    pointsNavRequests.length = 0;
    holdHitsForPipe = pipeId;
    return {
      pipeId,
      hour12Point,
      navKeys,
      initialTooltip: readVisibleTooltip(),
      date0: formatDateHover(0),
      date3: formatDateHover(3),
      date6: formatDateHover(6),
      date24: formatDateHover(24),
    };
  },

  async waitHeldPointsHit() {
    if (heldHits.length === 0) {
      await new Promise<void>(resolve => { hitWaiters.add(resolve); });
    }
    return {
      count: heldHits.length,
      key: heldHits[0]?.key ?? null,
    };
  },

  resolvePointsNavigate(hour: number) {
    const focus = pendingPointsFocusHour;
    if (!focus) throw new Error('Expected a pending onPointsNavigate request');
    pendingPointsFocusHour = null;
    focus(hour);
  },

  holdPointsHits(pipeId: number) {
    heldHits.length = 0;
    holdHitsForPipe = pipeId;
  },

  async waitPointsTooltipHour(expectedHour: number) {
    await waitForTooltipSubtitle(formatDateHover(expectedHour));
    return readVisibleTooltip();
  },

  async waitPinnedPointsTooltip(expectedHour: number) {
    const expectedSubtitle = formatDateHover(expectedHour);
    const expectedPinned = `Pinned at ${formatDateHover(24)}`;
    const matches = () => {
      const content = tooltipStore.get()?.content;
      return content?.subtitle === expectedSubtitle && content?.pinned === expectedPinned;
    };
    if (!matches()) {
      await new Promise<void>(resolve => {
        const stop = tooltipStore.subscribe(() => {
          if (!matches()) return;
          stop();
          resolve();
        });
      });
    }
    await waitAnimationFrames(1);
    return readVisibleTooltip();
  },

  async waitPointsFocusInstalled(pipeId: number, expectedHour: number) {
    const expectedKey = `plot:${expectedHour}`;
    await waitForPipeInstall(
      pipeId,
      () => (pipeline.view(pipeId)?.fields?.focusTooltip as { readonly text?: { readonly rowKey?: string } | null } | undefined)?.text?.rowKey === expectedKey,
    );
    await waitAnimationFrames(1);
  },

  async deliverHeldPointsHit(pipeId: number) {
    const pending = heldHits.shift();
    if (!pending) throw new Error('Expected a held pointer hit reply');
    holdHitsForPipe = null;
    pending.deliver();
    await waitAnimationFrames(4);
    return {
      visibleTooltip: readVisibleTooltip(),
      inspecting: pipeline.inspecting(pipeId),
      hoverHours: [...pointsHoverHours],
      navRequests: pointsNavRequests.map(req => ({ key: req.key, currentHour: req.currentHour })),
    };
  },

  async unmountPointsHost() {
    holdHitsForPipe = null;
    heldHits.length = 0;
    pendingPointsFocusHour = null;
    (document.activeElement as HTMLElement | null)?.blur();
    currentState = { ...currentState, pointsMode: null };
    renderApp();
    await waitAnimationFrames(2);
  },
};
