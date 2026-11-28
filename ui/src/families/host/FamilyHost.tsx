import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { deviceFit, watchDevicePixelRatio, windowRatio } from '../../charts/surface.ts';
import { useContextMenu, type MenuItem } from '../../components/ContextMenu';
import type { WidgetRuntime } from '../../dashboard/definitions';
import type { FailureOrigin } from '../../dashboard/follow/page.ts';
import { SharedSurfaceContext, SpatialLaneContext } from '../../dashboard/follow/sharedSurface.ts';
import type { WidgetBase } from '../../dashboard/model';
import { PreparingPage } from '../../dashboard/preparing.ts';
import { StripPageContext, type StripWidget } from '../../dashboard/strip/driver.ts';
import { EMPTY_STRIP_RECEIPT } from '../../dashboard/strip/store.ts';
import { TILE_ROSTER_FIELD, type TiledLine, type TileRosters } from '../../dashboard/tiles/view.ts';
import { useWidgetSkeleton } from '../../dashboard/widgetFrame.tsx';
import { useShownHour } from '../../dashboard/widgetPerf.ts';
import { holdElement } from '../../draw/bitmapSurface.ts';
import { useExportSurface } from '../../export/exportMotion.ts';
import { perfLog } from '../../shell/perf.ts';
import type { ArtResolutions } from '../art/provider.ts';
import type { LaneArtResolutions } from '../art/react.ts';
import { auditIdOf } from '../audit.ts';
import { displayedHour } from '../boundedView.ts';
import type {
  BoundedReadView,
  EntityKind,
  FamilyProjection,
  FamilySourceSubscription,
  InstalledAction,
  InstalledPicture,
  InstalledTransform,
  MirrorModel,
  SourcePlan,
} from '../contract.ts';
import type { IdentitySnapshot } from '../identity/types.ts';
import type { PagedRows } from '../table/rowSource.ts';
import { MEDIA_ROW_HEIGHT, ROW_HEIGHT, type TableDensity } from '../table/settings.ts';
import {
  familyBinding,
  familyInspectToken,
  lazyActionKeys,
  nextReportedRowWindow,
  parseFamilyHit,
  reconcileInstalledRowWindow,
  requestedRowWindow,
  sameRowWindow,
  type FamilyArtDemand,
  type FamilyContextHit,
  type FamilyGestureContext,
  type FamilyHostAdapter,
  type FamilyMetaState,
  type FamilyRowWindow,
  type FamilyStaticProof,
  type FamilyStaticSources,
  type FamilyViewportChange,
  type FamilyViewportState,
  type ParsedFamilyHit,
  type ReportedRowWindow,
} from './adapter.ts';
import { createPlanAuditVerifier, type FamilyAuditVerifier, type PlanAuditSnapshot } from './auditBinding.ts';
import { boundDated, ownProof, StaticSupply } from './dated.ts';
import { serializeTiledBySource } from '../sceneTiles.ts';
import { renderFamilyBodyState } from './FamilyBodyState.tsx';
import {
  anchoredRowWindow,
  handleFamilyGridKeyDown,
  handleFamilyKeyDown,
  handleFamilyPointsKeyDown,
  navPageSteps,
  nearestDataOrdinal,
  resolveInstalledOrdinal,
  tableOrdinalBounds,
  tablePageSteps,
  usableRowHeight,
  type FamilyNavTuple,
  type TableOrdinalMetrics,
} from './keyboard.ts';
import { NO_EXPANSION, type FamilyExpansion } from './expansion.ts';
import { BoundSelections, focusedSubject, inputBlocked, installedRecordOf, recordInstalled, resolveHostInput, type DrawnKeys, type HostCommand, type HostInput, type HostInputGate, type InstalledRecord } from './installed.ts';
import { keepEqual } from './stableValue.ts';
import { mirrorRowSelector, mirrorToSync, syncListboxMirror, syncTableHead, syncTableMirror, type ListboxMirrorItem } from './mirror.ts';
import { bindFamilyPointer } from './pointer.ts';
import { regionDropAt, regionRowOf, type RegionCommand, type RegionRowRef, type RegionRowsField } from '../regions/regionRows.ts';
import { computeScrollGeometry, physicalToLogicalTop, scrollRangeIntoView, type ScrollGeometry } from './scroll.ts';
import { reportFamilyShownHour } from './shownHour.ts';
import {
  attachAuditWatch,
  mountFamilyCanvas,
  useFamilyAnnouncer,
  useFamilyAudit,
  useFamilyHold,
  useFamilyPauseFlush,
  useFamilyPlacement,
  useFamilyTooltip,
  type MountedFamilyCanvas,
} from './surface.ts';
import { useFamilyTheme } from './theme.ts';
import { FamilyHeaderSummary, syncHeaderSummary } from './FamilyHeaderSummary.tsx';
import { mergeAccessibleDescription, mergeDiagnosticNotes, resolveHeaderSummary } from './headerSummary.ts';
import { rowHoverPublisher, rowPublisher, type TooltipRowSource } from './hoverRow.ts';
import type { FamilyTooltipField } from './tooltips.ts';
import './familyHost.css';

const DEFAULT_AUDIT_OWNER = -1;
const DEFAULT_POINTS_PAGE = 10;
const PLAN_VERIFIER = createPlanAuditVerifier<unknown, unknown>() as FamilyAuditVerifier<unknown>;
const EMPTY_NAV: readonly FamilyNavTuple[] = [];
const EMPTY_FIELDS: Readonly<Record<string, unknown>> = {};
const NO_STRINGS: readonly string[] = [];

interface RawMeta {
  readonly empty?: string | null;
  readonly emptyDetail?: string | null;
  readonly emptyKind?: 'empty' | 'unavailable';
  readonly playbackUnavailable?: true;
  readonly summaryText?: string | null;
  readonly summaryPartial?: string | null;
  readonly notes?: readonly string[];
  readonly warnings?: readonly string[];
  readonly transform?: InstalledTransform;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hasInstalledRows(record: InstalledRecord): boolean {
  if (record.nav.length > 0) return true;
  const range = record.fields.range as { readonly count?: number } | undefined;
  if (typeof range?.count === 'number' && range.count > 0) return true;
  const extent = record.fields.extent as { readonly rows?: readonly unknown[] } | undefined;
  return Array.isArray(extent?.rows) && extent.rows.length > 0;
}

function parseGridKey(key: string | null): { readonly row: number; readonly column: number } | null {
  if (!key) return null;
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  const row = Number(key.slice(0, idx));
  const column = Number(key.slice(idx + 1));
  return Number.isInteger(row) && Number.isInteger(column) && row >= 0 && column >= 0 ? { row, column } : null;
}

function formatGridKey(row: number, column: number): string {
  return `${row}:${column}`;
}

function revealGridAxis(index: number, cellSize: number, scroll: number, span: number): number {
  const start = index * cellSize;
  const end = start + cellSize;
  if (start < scroll) return start;
  if (end > scroll + span) return Math.max(0, end - span);
  return scroll;
}

function configuredTableRowHeight(fields: Readonly<Record<string, unknown>>, settings: unknown): number | undefined {
  const density = (settings as { readonly density?: TableDensity } | undefined)?.density;
  if (!density) return undefined;
  const media = (fields.meta as { readonly rowHeightMode?: string } | undefined)?.rowHeightMode === 'media';
  return (media ? MEDIA_ROW_HEIGHT : ROW_HEIGHT)[density];
}

function listboxItems(mirror: MirrorModel, selectedKey: string | null): readonly ListboxMirrorItem[] {
  return mirror.rows.map(row => ({
    key: row.key,
    spoken: [row.name, ...row.cells.map(c => c.spoken)].filter(Boolean).join(', '),
    index: row.rowIndex,
    selected: selectedKey === row.key,
  }));
}

interface HostInputAt extends HostInput {
  readonly at?: { readonly x: number; readonly y: number };
}

const canvasSizes = new WeakMap<HTMLCanvasElement, { readonly width: number; readonly height: number }>();

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const sized = canvasSizes.get(canvas);
  if (sized && sized.width === width && sized.height === height) return;
  canvasSizes.set(canvas, { width, height });
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function showPicture(canvas: HTMLCanvasElement, picture: { readonly width: number; readonly height: number; readonly dpr: number }, dpr: number) {
  sizeCanvas(canvas, Math.round(picture.width * picture.dpr) / dpr, Math.round(picture.height * picture.dpr) / dpr);
}

export interface FamilyChromeTargets {
  readonly body: HTMLElement | null;
  readonly bodyWrap: HTMLElement | null;
  readonly extent: HTMLElement | null;
}

export interface FamilyChromeProps<TSettings = unknown> {
  readonly state: unknown;
  readonly meta: FamilyMetaState;
  readonly settings: TSettings | undefined;
  readonly onSettings?: (next: TSettings) => void;
  readonly editable: boolean;
  readonly viewportWidth: number;
  readonly bodyBlocked: boolean;
  readonly announce: (message: string) => void;
  readonly targets: FamilyChromeTargets;
  readonly shownHour: () => number | null;
  readonly headerSlot: HTMLElement | null;
  readonly filterSlot?: HTMLElement | null;
  readonly setFilterOption?: (key: string, value: string) => void;
}

const NO_TARGETS: FamilyChromeTargets = { body: null, bodyWrap: null, extent: null };
const MIRROR_HOLD = {};

export interface PointsNavigateRequest {
  readonly key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';
  readonly currentHour: number | null;
  readonly zoomWindow: readonly [number, number] | null;
  readonly focusHour: (hour: number) => void;
}

export interface FamilyHostComponentProps<TModel = unknown, TOptions = unknown, TBinding = unknown, TSettings = unknown> {
  readonly adapter: FamilyHostAdapter<TModel, TOptions, TBinding, TSettings>;
  readonly settings?: TSettings;
  readonly onSettings?: (next: TSettings) => void;
  readonly editableSettings?: boolean;
  readonly chrome?: ComponentType<FamilyChromeProps<TSettings>>;
  readonly onWindowChange?: (window: FamilyRowWindow, hour: number | null) => void;
  readonly declaration: FamilyProjection<TModel, TOptions>;
  readonly view: string;
  readonly options: TOptions;
  readonly label: string;
  readonly subject: string;
  readonly widget: WidgetBase;
  readonly runtime: WidgetRuntime;
  readonly active: boolean;
  readonly subscriptions: readonly FamilySourceSubscription[];
  readonly allowEmptyFollow?: boolean;
  readonly owner?: string;
  readonly staticSources?: FamilyStaticSources | null;
  readonly staticProof?: FamilyStaticProof;
  readonly pagedRows?: PagedRows;
  readonly tiledSeries?: Readonly<Record<string, ReadonlyMap<string, TiledLine>>>;
  readonly hovers?: Readonly<Record<string, { readonly hour: number; readonly data: unknown }>>;
  readonly laneArt?: LaneArtResolutions;
  readonly extent?: readonly [number, number] | null;
  readonly plan?: SourcePlan | null;
  readonly exactReadView?: (hour: number, rowWindow: FamilyRowWindow | null, artResolutions?: ArtResolutions) => Promise<BoundedReadView | null>;
  readonly stripPlan?: Pick<StripWidget, 'key' | 'fixed' | 'supported' | 'keyframe' | 'track' | 'tiles' | 'identity'> & { tilesSettled(): boolean };
  readonly offset: number;
  readonly pin: number | null;
  readonly bounds?: readonly [number, number] | null;
  readonly identitySnapshot?: IdentitySnapshot | null;
  readonly onIdentityDemands?: (demands: readonly (readonly [EntityKind, string, number])[]) => void;
  readonly onArtDemands?: (demands: readonly FamilyArtDemand[]) => void;
  readonly onViewportChange?: (viewport: FamilyViewportChange) => void;
  readonly onHoverHour?: (hour: number | null, drawnKeys?: DrawnKeys) => void;
  readonly onTooltipRow?: (subject: string | null, by: TooltipRowSource) => void;
  readonly onInstalledHour?: (hour: number | null) => void;
  readonly onFollowedTileRanks?: (hour: number, proof: readonly [number, number], ranks: TileRosters | undefined) => void;
  readonly selectedKey?: string | null;
  readonly onActivate?: (action: InstalledAction) => void;
  readonly onPointsNavigate?: (request: PointsNavigateRequest) => boolean;
  readonly onToggle?: (action: InstalledAction) => void;
  readonly onRegions?: (command: RegionCommand) => string | null;
  readonly emptyAction?: ReactNode | ((openRegions: (anchor: { readonly x: number; readonly y: number }) => void) => ReactNode);
  readonly contextMenuItems?: (hit: FamilyContextHit) => MenuItem[];
  readonly headerSlot?: HTMLElement | null;
  readonly filterSlot?: HTMLElement | null;
  readonly setFilterOption?: (key: string, value: string) => void;
  readonly onDiagnostics?: (warnings: string[]) => void;
  readonly extraWarnings?: readonly string[];
  readonly blockedState?: ReactNode;
  readonly blockedLoading?: boolean;
  readonly keepFollowingWhenBlocked?: boolean;
  readonly bodyStatus?: string;
  readonly held?: boolean;
  readonly loadingLabel?: string;
  readonly className?: string;
}

function useViewportHeight(): number {
  const [height, setHeight] = useState(() => (typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 800));
  useEffect(() => {
    if (typeof globalThis.addEventListener !== 'function') return;
    const update = () => setHeight(typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 800);
    globalThis.addEventListener('resize', update);
    return () => globalThis.removeEventListener('resize', update);
  }, []);
  return height;
}

export default function FamilyHost<TModel = unknown, TOptions = unknown, TBinding = unknown, TSettings = unknown>({
  adapter,
  settings,
  onSettings,
  editableSettings = false,
  chrome: Chrome,
  onWindowChange,
  declaration,
  view,
  options,
  label,
  subject,
  widget,
  runtime,
  active,
  subscriptions,
  allowEmptyFollow = false,
  owner,
  staticSources = null,
  staticProof,
  pagedRows,
  tiledSeries,
  hovers,
  laneArt,
  extent = null,
  plan = null,
  exactReadView,
  stripPlan,
  offset,
  pin,
  bounds = null,
  identitySnapshot = null,
  onIdentityDemands,
  onArtDemands,
  onViewportChange,
  onHoverHour,
  onTooltipRow,
  onInstalledHour,
  onFollowedTileRanks,
  selectedKey = null,
  onActivate,
  onPointsNavigate,
  onToggle,
  onRegions,
  emptyAction,
  contextMenuItems,
  headerSlot = null,
  filterSlot,
  setFilterOption,
  onDiagnostics,
  extraWarnings,
  blockedState = null,
  blockedLoading = false,
  keepFollowingWhenBlocked = false,
  bodyStatus,
  held = false,
  loadingLabel,
  className = '',
}: FamilyHostComponentProps<TModel, TOptions, TBinding, TSettings>) {
  const prepared = useContext(PreparingPage);
  const sharedHost = useContext(SharedSurfaceContext);
  const spatialLanes = useContext(SpatialLaneContext);
  const preferredLane = spatialLanes?.get(widget.id);
  const exportSurface = useExportSurface();
  const exportReportRef = useRef(exportSurface.reportWidget);
  exportReportRef.current = exportSurface.reportWidget;
  useWidgetSkeleton(adapter.skeleton ?? 'chart');
  const viewportHeight = useViewportHeight();
  const contextMenu = useContextMenu(`${label} actions`);
  const contextMenuRef = useRef(contextMenu);
  contextMenuRef.current = contextMenu;

  const frameRef = useRef<HTMLDivElement & { playbackDiagnostics?: { bodyStatus?: string; metaMode?: string; installedBinding?: number } }>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listboxMirrorRef = useRef<HTMLDivElement>(null);
  const accessibleTableRef = useRef<HTMLTableElement>(null);
  const headerSummaryRef = useRef<HTMLSpanElement>(null);
  const mirrorBodyRef = useRef<HTMLTableSectionElement>(null);
  const mirrorHeadRef = useRef<HTMLTableSectionElement>(null);
  const bodyWrapRef = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<FamilyChromeTargets>(NO_TARGETS);
  const windowRef = useRef<ReportedRowWindow | null>(null);
  const requestedWindowRef = useRef<FamilyRowWindow | null>(null);
  const anchoredWindowRef = useRef<{ readonly first: number; readonly count: number } | null>(null);
  const [chromeState, setChromeState] = useState<unknown>(undefined);
  const chromeStateRef = useRef<unknown>(undefined);
  const [chromeWidth, setChromeWidth] = useState(0);
  const surfaceRef = useRef<MountedFamilyCanvas | null>(null);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const lastDescriptionRef = useRef<string | null>(null);

  const scrollMode = adapter.scroll ?? 'none';
  const mirrorKind = adapter.mirror ?? 'none';
  const pointerMode = adapter.pointerMode ?? 'discrete';

  const viewportRef = useRef({
    width: 0,
    height: 0,
    dpr: windowRatio(),
    scrollLeft: 0,
    scrollTop: 0,
    zoomWindow: null as readonly [number, number] | null,
  });
  const scrollGeometryRef = useRef<ScrollGeometry>(computeScrollGeometry(0, 0));
  const measuredRef = useRef(false);
  const lastViewportReportRef = useRef('');

  const focusedKeyRef = useRef<string | null>(null);
  const focusEpochRef = useRef(0);
  const pendingOrdinalRef = useRef<number | null>(null);
  const focusInsideRef = useRef(false);
  const focusAnchorRef = useRef({ x: 0, y: 0 });
  const regionDragRef = useRef<RegionRowRef | null>(null);
  const regionDropRef = useRef<HTMLDivElement>(null);
  const restoringFocusRef = useRef(false);
  const inspectedKeyRef = useRef<string | null>(null);
  const inspectedHitRef = useRef<ParsedFamilyHit | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastHoverHourRef = useRef<number | null>(null);
  const lastHoverKeys = useRef<{ picture?: DrawnKeys; asked?: DrawnKeys; owner?: string }>({});
  const heldRef = useRef(held);
  heldRef.current = held;
  const pauseFlushRef = useRef(0);
  const recordRef = useRef<InstalledRecord | null>(null);
  const lastInstalledHourRef = useRef<number | null>(null);
  const resolveInstalledRef = useRef<() => InstalledPicture | null>(() => recordRef.current?.picture ?? null);
  const selectionsRef = useRef(new BoundSelections());
  const typeaheadRef = useRef({ query: '', until: 0 });
  const expansionRef = useRef<FamilyExpansion>(NO_EXPANSION);

  const lastMirrorKeyRef = useRef('');
  const lastMirrorHeadKeyRef = useRef('');
  const lastMirrorObjRef = useRef<MirrorModel | null>(null);
  const lastMirrorSelectedRef = useRef<string | null>(null);
  const lastMirrorHourRef = useRef<number | null>(null);
  const lastMirrorSeekRef = useRef(-1);
  const lastMirrorCaptionRef = useRef<string | null>(null);
  const lastMirrorHadSourceRowsRef = useRef(false);
  const mirrorRequestRef = useRef(0);
  const mirrorNeedBindRef = useRef(false);
  const mirrorNeedBindBindingRef = useRef(-1);
  const fieldsNow = () => recordRef.current?.fields ?? EMPTY_FIELDS;
  const navNow = () => recordRef.current?.nav ?? EMPTY_NAV;
  const lastVisibleRef = useRef<boolean | null>(null);
  const lastExtentRef = useRef({ width: -1, height: -1 });
  const lastRawMetaRef = useRef<{ mode: string; reason: string | null; failureOrigin: FailureOrigin; raw: unknown } | null>(null);
  const lastPhasesRef = useRef<unknown>(null);
  const lastIdentityDemandsRef = useRef<unknown>(null);
  const lastArtDemandsRef = useRef<unknown>(null);
  const lastTableRef = useRef<unknown>(null);
  const lastRowCountRef = useRef(-1);
  const lastFocusNavRef = useRef<unknown>(null);
  const lastAuditRef = useRef<{ readonly id: number; readonly key: readonly unknown[] } | null>(null);

  const [meta, setMeta] = useState<FamilyMetaState>(() => ({
    mode: staticSources ? 'picture' : 'reading',
    reason: null,
    failureOrigin: 'local',
    empty: null,
    emptyDetail: null,
    emptyKind: 'empty',
    summaryText: null,
    summaryPartial: null,
    notes: NO_STRINGS,
    warnings: NO_STRINGS,
  }));
  const metaRef = useRef(meta);

  const { theme, reducedMotion } = useFamilyTheme();
  const { announce, hasFrame, liveRegionRef } = useFamilyAnnouncer(adapter.family);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const say = useCallback((message: string) => announceRef.current(message), []);

  const hasTiled = !!tiledSeries && Object.keys(tiledSeries).length > 0;
  const enabled = active && !prepared && (!blockedState || keepFollowingWhenBlocked) && (subscriptions.length > 0 || staticSources !== null || hasTiled || allowEmptyFollow);
  const auditable = !!exactReadView && !!adapter.deriveAuditRows;
  const resolvedOwner = owner ?? `${widget.id}:${declaration.kind}:${subject}`;

  const placement = useFamilyPlacement({
    family: adapter.family,
    declarationKind: declaration.kind,
    widgetId: widget.id,
    widgetKind: widget.kind,
    owner: resolvedOwner,
    subject,
    widgetTrackIds: widget.trackIds,
    runtime,
    enabled,
    auditable,
    subscriptions,
    offset,
    pin: pin ?? (subscriptions.length === 0 && staticSources && !staticSources.follows ? staticSources.hour : null),
    bounds,
    frameRef,
    surfaceLabel: adapter.family,
    ...(preferredLane !== undefined ? { preferredLane } : {}),
  });
  const { pipeline, pipe, sourceIdsRef, subsReady, instanceId, tooltipOwner, dataContextKey, retryStream, retryLocal } = placement;
  const strips = useContext(StripPageContext);
  const stripPlanRef = useRef(stripPlan);
  stripPlanRef.current = stripPlan;
  const stripWindowRef = useRef<FamilyRowWindow | null>(null);
  const resetStripWindow = useCallback((window: FamilyRowWindow | null) => {
    if (!strips || !stripPlanRef.current?.identity || stripPlanRef.current.fixed) return;
    strips.rowWindowChanged(stripWindowRef.current, window);
    stripWindowRef.current = window;
  }, [strips]);
  useLayoutEffect(() => {
    if (!strips || !active) return;
    const plan = stripPlanRef.current;
    const supported = plan?.supported === true;
    let reset = 0;
    const register = (available: boolean) => strips.register(widget.id, { ...plan,
      key: `${pipeline?.generation}:${pipe}:${reset}:${plan?.key}`, supported: supported && available,
      keyframe: plan?.keyframe ?? (() => ({ asks: [] })),
      scrub: pipeline?.scrub,
      settled: () => (!plan || plan.tilesSettled()) && (!pipeline || pipe === null || pipeline.stripSettled(pipe)),
      store: (build, update) => pipeline && pipe !== null ? pipeline.storeStrip(pipe, build, update) : Promise.resolve(EMPTY_STRIP_RECEIPT),
    });
    let available = !!pipeline && pipe !== null && pipeline.stripLaneAvailable(pipe);
    let release = register(available);
    const stop = pipeline && pipe !== null ? pipeline.onInstall(pipe, () => {
      if (available && !pipeline.stripLaneAvailable(pipe)) { available = false; release(); release = register(false); }
    }) : undefined;
    const stopReset = pipeline && pipe !== null ? pipeline.onStripReset(pipe, () => {
      reset++;
      release();
      release = register(available);
    }) : undefined;
    return () => { stop?.(); stopReset?.(); release(); };
  }, [strips, active, widget.id, pipeline, pipe, adapter.family, stripPlan?.key, stripPlan?.supported]);
  const activeLane = pipeline && pipe !== null ? pipeline.lane(pipe) : (preferredLane ?? null);
  const sharedSubscribe = useCallback((cb: () => void) => (sharedHost ? sharedHost.subscribe(cb) : () => {}), [sharedHost]);
  const sharedRead = useCallback(() => Boolean(sharedHost?.laneAvailable(activeLane)), [sharedHost, activeLane]);
  const sharedEnabled = useSyncExternalStore(sharedSubscribe, sharedRead, sharedRead);
  const useShared = !prepared && !exportSurface.active && sharedEnabled;

  useEffect(() => {
    if (!exportSurface.active || !exportSurface.reportWidget || !active || prepared || enabled) return undefined;
    const key = `${widget.id}:${instanceId}`;
    exportSurface.reportWidget(key, {
      widgetId: widget.id,
      pipe: null,
      mode: blockedLoading ? 'reading' : 'unavailable',
      target: null,
      binding: 0,
      installedBinding: 0,
      installedId: null,
      expired: false,
      pendingIdentities: false,
      pendingArt: false,
    });
    return () => {
      exportSurface.reportWidget?.(key, null);
    };
  }, [exportSurface.active, exportSurface.reportWidget, active, prepared, enabled, blockedLoading, widget.id, instanceId]);

  const tooltips = useFamilyTooltip(tooltipOwner, dataContextKey);
  useFamilyHold(frameRef, held, tooltips);

  const audit = useFamilyAudit<unknown>({
    pipeline,
    pipe,
    ownerId: adapter.auditOwnerId ?? DEFAULT_AUDIT_OWNER,
    auditable,
  });

  const reportShown = useShownHour();
  const reportShownRef = useRef(reportShown);
  reportShownRef.current = reportShown;

  const tiledBySource = useMemo(() => (tiledSeries ? serializeTiledBySource(tiledSeries) : undefined), [tiledSeries]);
  const latest = {
    adapter,
    settings,
    onWindowChange,
    hasChrome: !!Chrome,
    declaration,
    view,
    options,
    theme,
    reducedMotion,
    staticSources,
    staticProof,
    pagedRows,
    tiledSeries,
    tiledBySource,
    hovers,
    laneArt,
    extent,
    plan,
    exactReadView,
    onIdentityDemands,
    onArtDemands,
    onViewportChange,
    onHoverHour,
    onTooltipRow,
    onInstalledHour,
    onFollowedTileRanks,
    onDiagnostics,
    extraWarnings,
    selectedKey,
    onActivate,
    onPointsNavigate,
    onToggle,
    onRegions,
    contextMenuItems,
    viewportHeight,
    bounds,
    allowEmptyFollow,
    blocked: !!blockedState,
    captureActive: audit.captureActive,
    exportMotion: exportSurface.motion,
  };
  const latestRef = useRef(latest);
  const openRegionsAt = (anchor: { readonly x: number; readonly y: number }) => {
    const field = fieldsNow().regions as RegionRowsField | undefined;
    latestRef.current.onRegions?.({ op: 'open', x: anchor.x, y: anchor.y, rows: field?.rows ?? [], ...(field?.active ? { active: field.active } : {}) });
  };
  latestRef.current = latest;

  const tooltipRow = useCallback((by: TooltipRowSource) => () => {
    const report = latestRef.current.onTooltipRow;
    return report ? (subject: string | null) => report(subject, by) : undefined;
  }, []);
  const publishHoverRow = useMemo(() => rowHoverPublisher(() => latestRef.current.adapter, () => recordRef.current, tooltipRow('pointer')), [tooltipRow]);
  const publishFocusRow = useMemo(() => rowPublisher<string | null>(key => focusedSubject(latestRef.current.adapter, recordRef.current, key, parseGridKey), tooltipRow('focus')), [tooltipRow]);
  const publishFocusKey = useCallback(() => publishFocusRow(focusInsideRef.current ? focusedKeyRef.current : null), [publishFocusRow]);

  const publishHoverHour = useCallback((nextHour: number | null) => {
    const normalized = nextHour !== null && Number.isFinite(nextHour) ? Math.floor(nextHour) : null;
    const keys = normalized === null ? undefined : recordRef.current?.fields.drawnKeys as DrawnKeys | undefined;
    const previous = lastHoverKeys.current;
    const owner = normalized === null ? undefined : latestRef.current.plan?.owner;
    const drawnKeys = keys === previous.picture ? previous.asked : keys && keepEqual(previous.asked,
      Object.fromEntries(Object.entries(keys).map(([name, series]) => [name, [...series].sort()])));
    if (keys !== previous.picture || owner !== previous.owner) lastHoverKeys.current = { picture: keys, asked: drawnKeys, owner };
    if (normalized === lastHoverHourRef.current && drawnKeys === previous.asked && owner === previous.owner) return;
    lastHoverHourRef.current = normalized;
    latestRef.current.onHoverHour?.(normalized, drawnKeys);
  }, []);

  const notifyViewportChange = useCallback(() => {
    const cb = latestRef.current.onViewportChange;
    const vp = viewportRef.current;
    if (!cb || vp.width <= 0) return;
    const win = vp.zoomWindow;
    const sig = `${vp.width}|${vp.height}|${vp.dpr}|${win ? `${win[0]}:${win[1]}` : ''}`;
    if (sig === lastViewportReportRef.current) return;
    lastViewportReportRef.current = sig;
    focusEpochRef.current++;
    cb({ width: vp.width, height: vp.height, dpr: vp.dpr, window: win });
  }, []);

  const refreshFocusAnchor = useCallback(() => {
    const box = frameRef.current?.getBoundingClientRect();
    if (box) focusAnchorRef.current = { x: box.left + Math.min(200, box.width / 2), y: box.top + 48 };
  }, []);

  const reportWindow = useCallback(() => {
    const requested = requestedWindowRef.current;
    if (!requested) {
      windowRef.current = null;
      return;
    }
    const next = nextReportedRowWindow(
      windowRef.current,
      requested,
      recordRef.current?.picture.hour ?? null,
      latestRef.current.plan,
    );
    if (!next) return;
    windowRef.current = next;
    latestRef.current.onWindowChange?.(next.window, next.hour);
  }, []);

  const syncMirror = useCallback((mirror: MirrorModel | null) => {
    const kind = latestRef.current.adapter.mirror ?? 'none';
    const selected = recordRef.current?.selectedKey ?? null;
    if (kind === 'table') {
      syncTableHead(mirrorHeadRef.current, mirror?.columns ?? null, lastMirrorHeadKeyRef);
      const moved = syncTableMirror(mirrorBodyRef.current, mirror, {
        selectedKey: selected,
        rowsFocusable: (latestRef.current.adapter.mirrorFocus ?? 'body') === 'rows',
        focusedKeyRef,
        focusInsideRef,
        restoringFocusRef,
        lastMirrorKeyRef,
        holdFocus: pendingOrdinalRef.current !== null,
      });
      if (moved) queueMicrotask(() => bindRef.current());
      return;
    }
    if (kind !== 'listbox') return;
    const res = syncListboxMirror(listboxMirrorRef.current, mirror ? listboxItems(mirror, selected) : null, {
      optionIdPrefix: `${latestRef.current.adapter.family}-${instanceId}`,
      total: mirror?.total ?? 0,
      focusedKey: focusedKeyRef.current,
      lastMirrorKeyRef,
    });
    if (!bodyRef.current) return;
    if (res.activeDescendantId) bodyRef.current.setAttribute('aria-activedescendant', res.activeDescendantId);
    else bodyRef.current.removeAttribute('aria-activedescendant');
  }, [instanceId]);
  const syncMirrorRef = useRef(syncMirror);
  syncMirrorRef.current = syncMirror;

  const mirrorElement = useCallback((): Element | null => {
    const kind = latestRef.current.adapter.mirror ?? 'none';
    if (kind === 'table') return accessibleTableRef.current;
    if (kind === 'listbox') return listboxMirrorRef.current;
    return null;
  }, []);

  const syncTableTabIndex = useCallback((hasFocusableRow: boolean) => {
    const table = accessibleTableRef.current;
    if (!table || (latestRef.current.adapter.mirrorFocus ?? 'body') !== 'rows') return;
    const nextTab = hasFocusableRow || latestRef.current.blocked ? -1 : 0;
    if (hasFocusableRow && !latestRef.current.blocked && pendingOrdinalRef.current === null && document.activeElement === table) {
      const targetRow = mirrorBodyRef.current?.querySelector<HTMLTableRowElement>('tr[tabindex="0"]');
      if (targetRow) {
        restoringFocusRef.current = true;
        try {
          targetRow.focus({ preventScroll: true });
        } finally {
          restoringFocusRef.current = false;
        }
      }
    }
    if (table.tabIndex !== nextTab) table.tabIndex = nextTab;
  }, []);

  const clearMirror = useCallback(() => {
    const el = mirrorElement();
    if (lastMirrorObjRef.current !== null) {
      lastMirrorObjRef.current = null;
      syncMirrorRef.current(null);
    } else {
      syncTableHead(mirrorHeadRef.current, null, lastMirrorHeadKeyRef);
    }
    lastMirrorSelectedRef.current = null;
    lastMirrorHourRef.current = null;
    lastMirrorSeekRef.current = -1;
    lastRowCountRef.current = -1;
    lastMirrorCaptionRef.current = null;
    lastMirrorHadSourceRowsRef.current = false;
    mirrorNeedBindRef.current = false;
    mirrorNeedBindBindingRef.current = -1;
    mirrorRequestRef.current++;
    if (accessibleTableRef.current) {
      accessibleTableRef.current.removeAttribute('aria-rowcount');
      if (accessibleTableRef.current.caption) accessibleTableRef.current.deleteCaption();
    }
    syncTableTabIndex(false);
    if (el) {
      el.removeAttribute('data-mirror-hour');
      holdElement(el, false, MIRROR_HOLD);
    }
  }, [mirrorElement, syncTableTabIndex]);

  const commitMirror = useCallback((record: InstalledRecord, force: boolean, seekSeq: number, recordSeek: boolean) => {
    const el = mirrorElement();
    if (!el) return;
    const fields = record.fields;
    const nextMirror = fields.mirror as MirrorModel | undefined;
    if (nextMirror === undefined) {
      const missingInitial = lastMirrorHourRef.current === null;
      const missingFirstRow = (lastMirrorObjRef.current?.rows.length ?? 0) === 0
        && !lastMirrorHadSourceRowsRef.current
        && hasInstalledRows(record);
      const missingSeek = recordSeek && lastMirrorSeekRef.current !== seekSeq;
      const canRetry = !mirrorNeedBindRef.current
        || (mirrorNeedBindBindingRef.current > 0 && record.picture.generation.binding >= mirrorNeedBindBindingRef.current);
      if ((missingInitial || missingFirstRow || missingSeek) && canRetry) {
        mirrorNeedBindRef.current = true;
        mirrorNeedBindBindingRef.current = -1;
        mirrorRequestRef.current++;
        queueMicrotask(() => {
          bindRef.current();
          if (pipeline && pipe !== null) mirrorNeedBindBindingRef.current = pipeline.binding(pipe);
        });
      }
      holdElement(el, true, MIRROR_HOLD);
      return;
    }
    mirrorNeedBindRef.current = false;
    mirrorNeedBindBindingRef.current = -1;
    lastMirrorHadSourceRowsRef.current = hasInstalledRows(record);
    const toSync = force
      ? nextMirror
      : mirrorToSync(nextMirror, lastMirrorObjRef.current, record.selectedKey, lastMirrorSelectedRef.current);
    if (toSync !== undefined) {
      lastMirrorObjRef.current = toSync;
      lastMirrorSelectedRef.current = record.selectedKey;
      syncMirrorRef.current(toSync);
    }
    if ((latestRef.current.adapter.mirror ?? 'none') === 'table') {
      const table = fields.table as TableOrdinalMetrics | undefined;
      const tableEl = accessibleTableRef.current;
      if (table && lastRowCountRef.current !== table.count) {
        lastRowCountRef.current = table.count;
        tableEl?.setAttribute('aria-rowcount', String(table.count + 1));
      }
      if (tableEl) {
        const desiredCaption = !latestRef.current.blocked && metaRef.current.mode === 'picture' && !metaRef.current.empty
          ? (resolveHeaderSummary(metaRef.current)?.spoken ?? null)
          : null;
        if (desiredCaption !== null) {
          const caption = tableEl.caption ?? tableEl.createCaption();
          if (caption.textContent !== desiredCaption) caption.textContent = desiredCaption;
        } else if (tableEl.caption) {
          tableEl.deleteCaption();
        }
        lastMirrorCaptionRef.current = desiredCaption;
      }
      syncTableTabIndex(Boolean(lastMirrorObjRef.current?.rows.some(r => !r.groupHeader)));
    }
    const hour = record.picture.hour;
    if (lastMirrorHourRef.current !== hour) {
      lastMirrorHourRef.current = hour;
      el.setAttribute('data-mirror-hour', String(hour));
    }
    if (recordSeek) lastMirrorSeekRef.current = seekSeq;
    holdElement(el, false, MIRROR_HOLD);
  }, [mirrorElement, syncTableTabIndex, pipeline, pipe]);
  const commitMirrorRef = useRef(commitMirror);
  commitMirrorRef.current = commitMirror;
  const clearMirrorRef = useRef(clearMirror);
  clearMirrorRef.current = clearMirror;

  const datedNow = useCallback(() => {
    const cur = latestRef.current;
    return boundDated(
      cur.staticSources,
      ownProof(cur.staticSources, cur.staticProof?.read() ?? null),
      Object.keys(sourceIdsRef.current).length > 0,
      cur.allowEmptyFollow || (!!cur.tiledSeries && Object.keys(cur.tiledSeries).length > 0),
      cur.bounds,
    ) ?? null;
  }, [sourceIdsRef]);

  const supply = useMemo(() => (pipeline && pipe !== null ? new StaticSupply(change => pipeline.supply(pipe, change)) : null), [pipeline, pipe]);
  const supplyDated = useCallback(() => supply?.date(latestRef.current.staticSources, datedNow()), [supply, datedNow]);

  const frame = useCallback(() => {
    const cur = latestRef.current;
    const curAdapter = cur.adapter;
    const [defW, defH] = curAdapter.defaultSize ?? [320, 200];
    const vp = viewportRef.current;
    if (!measuredRef.current && bodyRef.current && typeof ResizeObserver === 'function') {
      const fit = deviceFit(bodyRef.current, bodyRef.current.clientWidth, bodyRef.current.clientHeight);
      vp.width = fit.width;
      vp.height = fit.height;
      vp.dpr = fit.dpr;
      measuredRef.current = true;
    }
    const hidden = measuredRef.current && (vp.width <= 0 || vp.height <= 0);
    const w = hidden ? 0 : vp.width || defW;
    const h = hidden ? 0 : vp.height || defH;
    const dpr = vp.dpr;
    const viewport: FamilyViewportState = {
      width: w,
      height: h,
      dpr,
      scrollLeft: vp.scrollLeft,
      scrollTop: physicalToLogicalTop(vp.scrollTop, scrollGeometryRef.current),
      zoomWindow: vp.zoomWindow,
    };
    const anchor = anchoredWindowRef.current;
    const fields = fieldsNow();
    const asked = anchor
      ? anchoredRowWindow(anchor, fields.table as TableOrdinalMetrics | undefined)
      : requestedRowWindow(curAdapter, cur.plan, viewport, cur.settings, fields);
    const held = requestedWindowRef.current;
    const rowWindow = sameRowWindow(held, asked) ? held : asked;

    const artResolutions = cur.laneArt?.resolutions;
    let auditId: number | undefined;
    if (perfLog && cur.captureActive && cur.exactReadView && curAdapter.deriveAuditRows) {
      const key = [cur.declaration, cur.options, cur.exactReadView, curAdapter.deriveAuditRows, viewport.width, viewport.height, viewport.scrollLeft, viewport.scrollTop, rowWindow?.first, rowWindow?.count, rowWindow?.dataFirst, rowWindow?.dataCount, cur.settings, expansionRef.current, cur.theme, artResolutions];
      const prev = lastAuditRef.current;
      if (prev && prev.key.length === key.length && prev.key.every((part, i) => part === key[i])) {
        auditId = prev.id;
      } else {
        const deriveRows = curAdapter.deriveAuditRows;
        const readExact = cur.exactReadView;
        const context = { viewport, settings: cur.settings, expanded: expansionRef.current, theme: cur.theme };
        const snapshot: PlanAuditSnapshot<TModel, TOptions> = {
          projection: cur.declaration,
          options: cur.options,
          exactReadView: hour => readExact(hour, rowWindow, artResolutions),
          deriveRows: (model, hour, fields) => deriveRows(model, hour, { ...context, fields: fields ?? EMPTY_FIELDS }),
          ...(curAdapter.auditOrdered !== undefined ? { ordered: curAdapter.auditOrdered } : {}),
        };
        auditId = audit.capture(snapshot, PLAN_VERIFIER);
        lastAuditRef.current = { id: auditId, key };
      }
    }

    const view = {
      scrollTop: viewport.scrollTop,
      scrollLeft: viewport.scrollLeft,
      window: rowWindow ?? null,
      audit: auditId !== undefined,
      auditId: auditId ?? null,
      ...curAdapter.buildView?.({ viewport }),
    };
    return { cur, curAdapter, w, h, dpr, hidden, viewport, rowWindow, auditId, view, artResolutions };
  }, [audit.capture, sourceIdsRef]);

  const supplyDataFields = (cur: typeof latestRef.current) => ({
    tiledBySource: cur.tiledBySource,
    hovers: cur.hovers && Object.keys(cur.hovers).length ? cur.hovers : undefined,
    pagedRows: cur.pagedRows && Object.keys(cur.pagedRows).length ? cur.pagedRows : undefined,
  });
  const supplyArtFields = (cur: typeof latestRef.current) => ({
    artResolutions: cur.laneArt?.resolutions,
  });

  const showView = useCallback(() => {
    if (!surfaceRef.current || !pipeline || pipe === null) return;
    const { cur, rowWindow, view, artResolutions } = frame();
    resetStripWindow(rowWindow);
    requestedWindowRef.current = rowWindow;
    reportWindow();
    supply?.update({ view, data: supplyDataFields(cur), art: { artResolutions } });
  }, [frame, pipeline, pipe, reportWindow, resetStripWindow, supply]);

  const bind = useCallback(() => {
    const mounted = surfaceRef.current;
    if (!mounted || !pipeline || pipe === null) return;
    const { cur, curAdapter, w, h, dpr, hidden, viewport, rowWindow, auditId, view, artResolutions } = frame();
    const binding = familyBinding(curAdapter, {
      kind: cur.declaration.kind,
      view: cur.view,
      options: cur.options,
      settings: cur.settings,
      sources: sourceIdsRef.current,
      extent: cur.extent,
      plan: cur.plan,
      viewport,
      theme: cur.theme,
      reducedMotion: cur.reducedMotion,
      selectedKey: cur.selectedKey,
      focusedKey: focusInsideRef.current ? focusedKeyRef.current : null,
      ...(focusInsideRef.current ? { focusInside: true } : {}),
      expanded: expansionRef.current,
      audit: auditId !== undefined,
      auditId,
      pauseFlush: pauseFlushRef.current,
      ...(mirrorRequestRef.current > 0 ? { mirrorRequest: mirrorRequestRef.current } : {}),
      window: rowWindow,
      ...(cur.exportMotion ? { motion: cur.exportMotion } : {}),
    });
    if (binding === null) return;
    resetStripWindow(rowWindow);
    requestedWindowRef.current = rowWindow;
    reportWindow();

    if (!hidden) {
      const shown = pipeline.view(pipe);
      if (shown?.mode === 'picture' && shown.viewport) showPicture(mounted.canvas, shown.viewport, dpr);
      else sizeCanvas(mounted.canvas, w, h);
    }
    pipeline.present(pipe, curAdapter.family);
    pipeline.bind(pipe, mounted.workerPresented ? [] : [mounted.surface], { surfaces: [{ width: w, height: h, dpr }] }, {}, binding);
    const boundView = pipeline.view(pipe);
    const bound = boundView?.binding;
    if (bound !== undefined) selectionsRef.current.bound(bound, cur.selectedKey);
    if (exportReportRef.current) {
      exportReportRef.current(`${widget.id}:${instanceId}`, {
        widgetId: widget.id,
        pipe,
        mode: boundView?.mode ?? 'reading',
        target: boundView?.target ?? null,
        binding: boundView?.binding ?? 0,
        installedBinding: boundView?.installedBinding ?? 0,
        installedId: boundView?.id ?? null,
        expired: boundView?.expired === true,
        pendingIdentities: Array.isArray(boundView?.fields?.identityDemands) && (boundView.fields.identityDemands as unknown[]).length > 0,
        pendingArt: Array.isArray(boundView?.fields?.artDemands) && (boundView.fields.artDemands as unknown[]).length > 0,
      });
    }
    supply?.update({ view, data: supplyDataFields(cur), art: { artResolutions } });
    supplyDated();
  }, [frame, pipeline, pipe, supply, supplyDated, reportWindow, resetStripWindow, widget.id, instanceId]);
  const showViewRef = useRef(showView);
  showViewRef.current = showView;

  const bindRef = useRef(bind);
  bindRef.current = bind;
  const clearHoverRef = useRef<() => void>(() => {});

  const setZoomWindow = useCallback((next: readonly [number, number] | null) => {
    const prev = viewportRef.current.zoomWindow;
    if (prev === next || (prev && next && prev[0] === next[0] && prev[1] === next[1])) return;
    viewportRef.current.zoomWindow = next;
    clearHoverRef.current();
    notifyViewportChange();
    showViewRef.current();
  }, [notifyViewportChange]);

  const gestureContext = useCallback((): FamilyGestureContext => ({
    fields: fieldsNow(),
    viewport: { ...viewportRef.current },
    extent: latestRef.current.extent,
    setZoomWindow,
  }), [setZoomWindow]);

  const gateNow = useCallback((): HostInputGate => ({
    current: latestRef.current.blocked ? null : installedRecordOf(resolveInstalledRef.current()),
    held: heldRef.current,
    expired: !!pipeline && pipe !== null && pipeline.view(pipe)?.expired === true,
  }), [pipeline, pipe]);

  const dispatch = useCallback((command: HostCommand, input: HostInputAt): boolean => {
    const cur = latestRef.current;
    const effect = resolveHostInput(cur.adapter, command, input, gateNow(), {
      expansion: expansionRef.current,
      takesToggles: !!cur.onToggle,
      regions: !!cur.onRegions,
      menu: !!cur.contextMenuItems,
    }, parseGridKey);
    if (!effect) return false;
    pendingOrdinalRef.current = null;
    switch (effect.kind) {
      case 'menu': {
        const items = cur.contextMenuItems!(effect.hit);
        if (!items.length) return false;
        const at = input.at ?? focusAnchorRef.current;
        contextMenuRef.current.open(at.x, at.y, items);
        return true;
      }
      case 'pin':
        tooltips.pinFocused(effect.tip, effect.hour, focusAnchorRef.current, cur.viewportHeight, say);
        return true;
      case 'region-open': {
        const field = effect.field;
        const box = bodyRef.current?.getBoundingClientRect();
        const at = field.add
          ? { x: (box?.left ?? 0) + field.nameLeft, y: (box?.top ?? 0) + field.add.top + field.add.height - viewportRef.current.scrollTop }
          : focusAnchorRef.current;
        cur.onRegions!({ op: 'open', x: at.x, y: at.y, aside: (box?.left ?? 0) + field.nameRight, rows: field.rows, ...(field.active ? { active: field.active } : {}) });
        return true;
      }
      case 'region-remove': {
        const message = cur.onRegions!({ op: 'remove', row: effect.row });
        if (message) say(message);
        return true;
      }
      case 'activate':
        focusEpochRef.current++;
        if (cur.onPointsNavigate) focusedKeyRef.current = null;
        tooltips.dismissActivated(effect.key);
        cur.onActivate?.(effect.action);
        return true;
      case 'toggle':
        if (command !== 'toggle' && input.key !== null) tooltips.dismissActivated(input.key);
        if (!effect.expansion) {
          cur.onToggle?.(effect.action);
          return true;
        }
        expansionRef.current = effect.expansion.next;
        say(`${effect.expansion.label} ${effect.expansion.open ? 'expanded' : 'collapsed'}.`);
        bindRef.current();
        return true;
    }
  }, [gateNow, say, tooltips]);

  const revealRow = useCallback((entry: FamilyNavTuple): boolean => {
    const top = entry[6];
    const height = entry[7];
    if (top === undefined || height === undefined) return false;
    const vp = viewportRef.current;
    const rows = { scrollTop: vp.scrollTop, height: usableRowHeight(fieldsNow(), vp.height) };
    const moved = scrollRangeIntoView(bodyRef.current, rows, top, height, scrollGeometryRef.current);
    vp.scrollTop = bodyRef.current && moved ? Math.floor(bodyRef.current.scrollTop) : rows.scrollTop;
    return moved;
  }, []);

  const focusRowByKey = useCallback((key: string) => {
    const entry = navNow().find(item => item[0] === key);
    if (!entry) return;
    pendingOrdinalRef.current = null;
    focusedKeyRef.current = key;
    revealRow(entry);
    if ((latestRef.current.adapter.mirrorFocus ?? 'body') === 'rows') {
      const record = recordRef.current;
      if (record?.fields.mirror !== undefined && (lastMirrorHourRef.current !== record.picture.hour || record.fields.mirror !== lastMirrorObjRef.current)) {
        const snap = runtime.clock.getSnapshot();
        const settled = !(pipeline && pipe !== null && pipeline.view(pipe)?.dim);
        commitMirrorRef.current(record, false, snap.seekSequence ?? 0, settled);
      }
      const tr = mirrorBodyRef.current?.querySelector<HTMLTableRowElement>(mirrorRowSelector(key));
      if (tr) {
        for (const sibling of mirrorBodyRef.current!.querySelectorAll<HTMLTableRowElement>('tr[tabindex="0"]')) {
          if (sibling !== tr) sibling.tabIndex = -1;
        }
        tr.tabIndex = 0;
        tr.focus({ preventScroll: true });
      }
    }
    bindRef.current();
  }, [revealRow, runtime.clock, pipeline, pipe]);

  const focusRowByOrdinal = useCallback((ordinal: number, direction: 1 | -1 = 1) => {
    const record = recordRef.current;
    const fields = record?.fields ?? EMPTY_FIELDS;
    const table = fields.table as TableOrdinalMetrics | undefined;
    if (!record || !table || fields.panes) return;
    const target = nearestDataOrdinal(ordinal, table.count, table.gapBefore, direction);
    if (target === null) return;
    const entry = resolveInstalledOrdinal(
      record.nav,
      target,
      table,
      requestedWindowRef.current,
      fields.mirror as MirrorModel | undefined,
      record.picture.actionKeys,
    );
    if (entry) {
      if (!anchoredWindowRef.current && entry[2] < target && requestedWindowRef.current) {
        anchoredWindowRef.current = { first: requestedWindowRef.current.first, count: requestedWindowRef.current.count };
      }
      pendingOrdinalRef.current = null;
      focusRowByKey(entry[0]);
      return;
    }
    anchoredWindowRef.current = null;
    const bounds = tableOrdinalBounds(table, record.nav, target, configuredTableRowHeight(fields, latestRef.current.settings));
    if (!bounds) return;
    pendingOrdinalRef.current = target;
    const node = bodyRef.current;
    const vp = viewportRef.current;
    const rows = { scrollTop: vp.scrollTop, height: usableRowHeight(fields, vp.height) };
    const moved = scrollRangeIntoView(node, rows, bounds.top, bounds.height, scrollGeometryRef.current);
    vp.scrollTop = node && moved ? Math.floor(node.scrollTop) : rows.scrollTop;
    showViewRef.current();
  }, [focusRowByKey]);

  const focusGridCell = useCallback((row: number, column: number) => {
    const curAdapter = latestRef.current.adapter;
    const metrics = curAdapter.getGridMetrics?.(fieldsNow());
    focusedKeyRef.current = (curAdapter.formatGridKey ?? formatGridKey)(row, column);
    const node = bodyRef.current;
    if (node && metrics) {
      const vp = viewportRef.current;
      const nextLeft = revealGridAxis(column, metrics.cellWidth ?? metrics.cellSize, node.scrollLeft, Math.max(1, vp.width - metrics.gridLeft));
      const nextTop = revealGridAxis(row, metrics.cellSize, node.scrollTop, Math.max(1, vp.height - metrics.gridTop));
      if (nextLeft !== node.scrollLeft) node.scrollLeft = vp.scrollLeft = nextLeft;
      if (nextTop !== node.scrollTop) node.scrollTop = vp.scrollTop = nextTop;
      const rowLabel = metrics.rowLabel?.(row);
      const columnLabel = metrics.columnLabel?.(column);
      if (rowLabel && columnLabel) say(`${rowLabel} to ${columnLabel}`);
    }
    bindRef.current();
  }, [say]);

  useLayoutEffect(() => {
    focusEpochRef.current++;
    recordRef.current = null;
    regionDragRef.current = null;
    expansionRef.current = NO_EXPANSION;
    focusedKeyRef.current = null;
    pendingOrdinalRef.current = null;
    anchoredWindowRef.current = null;
    inspectedKeyRef.current = null;
    inspectedHitRef.current = null;
    clearMirrorRef.current();
    publishHoverHour(null);
    publishHoverRow(null);
    publishFocusRow(null);
    if (viewportRef.current.zoomWindow) {
      viewportRef.current.zoomWindow = null;
      notifyViewportChange();
    }
  }, [resolvedOwner, publishHoverHour, notifyViewportChange]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node || !pipeline || pipe === null) return;
    lastExtentRef.current = { width: -1, height: -1 };
    lastRawMetaRef.current = null;
    lastMirrorObjRef.current = null;
    lastMirrorHeadKeyRef.current = '';
    lastMirrorHourRef.current = null;
    lastMirrorSeekRef.current = -1;
    lastRowCountRef.current = -1;
    lastMirrorCaptionRef.current = null;
    lastMirrorHadSourceRowsRef.current = false;
    mirrorNeedBindRef.current = false;
    mirrorNeedBindBindingRef.current = -1;
    lastVisibleRef.current = null;
    lastPhasesRef.current = null;
    lastIdentityDemandsRef.current = null;
    lastArtDemandsRef.current = null;
    lastViewportReportRef.current = '';

    const mountAdapter = latestRef.current.adapter;
    const mounted = mountFamilyCanvas(node, pipeline, pipe, mountAdapter.family, 'fh-canvas', 'fh-extent', useShared);
    if ((mountAdapter.scroll ?? 'none') === 'none') {
      mounted.extent.style.width = '100%';
      mounted.extent.style.height = '100%';
    }
    surfaceRef.current = mounted;
    const unregisterShared = useShared && sharedHost && frameRef.current
      ? sharedHost.register(pipe, pipeline.lane(pipe), node, frameRef.current)
      : null;
    if (latestRef.current.hasChrome) setTargets({ body: node, bodyWrap: bodyWrapRef.current, extent: mounted.extent });

    const auditWatch = attachAuditWatch(pipeline, pipe, {
      isAuditable: () => !!latestRef.current.exactReadView && !!latestRef.current.adapter.deriveAuditRows,
      onCaptureChange: activeAudit => { latestRef.current.captureActive = activeAudit; },
      bindNow: () => bindRef.current(),
    });

    const describe = (text: string | null) => {
      if (text === lastDescriptionRef.current) return;
      lastDescriptionRef.current = text;
      const target = descriptionRef.current;
      if (target) target.textContent = text ?? '';
      if (text && target) node.setAttribute('aria-describedby', target.id);
      else node.removeAttribute('aria-describedby');
    };

    const updateMeta = (mode: string, reason: string | null, failureOrigin: FailureOrigin, raw: RawMeta | undefined) => {
      const prev = lastRawMetaRef.current;
      if (prev && prev.mode === mode && prev.reason === reason && prev.failureOrigin === failureOrigin && prev.raw === raw) return;
      lastRawMetaRef.current = { mode, reason, failureOrigin, raw };
      const empty = raw?.empty ?? null;
      const emptyDetail = raw?.emptyDetail ?? null;
      const emptyKind = raw?.emptyKind ?? 'empty';
      const playbackUnavailable = raw?.playbackUnavailable;
      const summaryText = raw?.summaryText ?? null;
      const summaryPartial = raw?.summaryPartial ?? null;
      const notes = raw?.notes ?? NO_STRINGS;
      const warnings = raw?.warnings ?? NO_STRINGS;
      const shown = metaRef.current;
      const sameNotes = sameStrings(shown.notes, notes);
      const sameWarnings = sameStrings(shown.warnings, warnings);
      const sameBody =
        shown.mode === mode && shown.reason === reason && shown.failureOrigin === failureOrigin
        && shown.empty === empty && shown.emptyDetail === emptyDetail && shown.emptyKind === emptyKind && shown.playbackUnavailable === playbackUnavailable
        && sameNotes;
      const sameSummary = shown.summaryText === summaryText && shown.summaryPartial === summaryPartial;
      if (sameBody && sameSummary && sameWarnings) return;
      const next: FamilyMetaState = { mode, reason, failureOrigin, empty, emptyDetail, emptyKind, ...(playbackUnavailable ? { playbackUnavailable } : {}), summaryText, summaryPartial, notes, warnings };
      metaRef.current = next;
      const diagnostics = latestRef.current.onDiagnostics;
      if (diagnostics && (!sameWarnings || !sameNotes)) diagnostics(mergeDiagnosticNotes(latestRef.current.extraWarnings, warnings, notes));
      if (sameBody && sameSummary) return;
      if (sameBody && shown.summaryPartial === summaryPartial && shown.summaryText?.trim() && summaryText?.trim()) {
        syncHeaderSummary(headerSummaryRef.current, resolveHeaderSummary(next));
        return;
      }
      setMeta(next);
    };

    const install = () => {
      const shown = pipeline.view(pipe);
      const frameNode = frameRef.current;
      if (perfLog && frameNode) (frameNode.playbackDiagnostics ??= {}).installedBinding = shown?.installedBinding;
      const cur = latestRef.current;
      const activeAdapter = cur.adapter;
      holdElement(frameNode, !!shown?.dim);
      const visible = shown?.mode === 'picture';
      if (visible && shown.viewport) showPicture(mounted.canvas, shown.viewport, viewportRef.current.dpr);
      if (lastVisibleRef.current !== visible) {
        lastVisibleRef.current = visible;
        node.toggleAttribute('data-family-visible', visible);
        node.toggleAttribute('data-family-pending', !visible);
      }
      const shownHour = reportFamilyShownHour(reportShownRef.current, visible, shown);
      auditWatch.settleIfReady(visible, shown?.mode ?? 'reading', shown?.installedBinding, shown?.fields);
      if (exportReportRef.current) {
        exportReportRef.current(`${widget.id}:${instanceId}`, {
          widgetId: widget.id,
          pipe,
          mode: shown?.mode ?? 'reading',
          target: shown?.target ?? null,
          binding: shown?.binding ?? 0,
          installedBinding: shown?.installedBinding ?? 0,
          installedId: shown?.id ?? null,
          expired: shown?.expired === true,
          pendingIdentities: Array.isArray(shown?.fields?.identityDemands) && (shown.fields.identityDemands as unknown[]).length > 0,
          pendingArt: Array.isArray(shown?.fields?.artDemands) && (shown.fields.artDemands as unknown[]).length > 0,
        });
      }

      const fields = shown?.fields;
      const rawMeta = fields?.meta as RawMeta | undefined;
      updateMeta(shown?.waiting ? 'waiting' : shown?.mode ?? 'reading', shown?.reason ?? null, shown?.failureOrigin ?? 'local', rawMeta);

      const idDemands = fields?.identityDemands as readonly (readonly [EntityKind, string, number])[] | undefined;
      if (idDemands && idDemands !== lastIdentityDemandsRef.current && cur.onIdentityDemands) {
        lastIdentityDemandsRef.current = idDemands;
        cur.onIdentityDemands(idDemands);
      }
      const artDemands = fields?.artDemands as readonly FamilyArtDemand[] | undefined;
      if (artDemands && artDemands !== lastArtDemandsRef.current && cur.onArtDemands) {
        lastArtDemandsRef.current = artDemands;
        cur.onArtDemands(artDemands);
      }

      if (!visible || !fields || shown?.id === undefined) {
        if (cur.onFollowedTileRanks) {
          const hour = shown?.target ?? runtime.clock.getHour();
          cur.onFollowedTileRanks(hour, [hour, hour], undefined);
        }
        recordRef.current = null;
        if (lastInstalledHourRef.current !== null) {
          lastInstalledHourRef.current = null;
          cur.onInstalledHour?.(null);
        }
        publishFocusKey();
        describe(null);
        clearMirrorRef.current();
        tooltips.hideIfUnpinned();
        return;
      }

      const installedHour = displayedHour(shownHour ?? shown.painted ?? shown.h ?? 0);
      if (lastInstalledHourRef.current !== installedHour) {
        lastInstalledHourRef.current = installedHour;
        cur.onInstalledHour?.(installedHour);
      }
      const base = shown.viewport ?? {
        width: viewportRef.current.width,
        height: viewportRef.current.height,
        dpr: viewportRef.current.dpr,
        scrollLeft: viewportRef.current.scrollLeft,
        scrollTop: viewportRef.current.scrollTop,
      };
      const installedAuditId = auditIdOf(fields.audit);
      const installed: InstalledPicture = {
        id: shown.id,
        owner: shown.installedOwner ?? shown.owner ?? '',
        generation: {
          seek: shown.gen?.seek ?? 0,
          reset: shown.gen?.reset ?? 0,
          binding: shown.installedBinding ?? shown.binding ?? 0,
        },
        factRevisions: {},
        validInterval: shown.validInterval ?? [installedHour, installedHour],
        through: shown.through ?? installedHour,
        hour: installedHour,
        viewport: rawMeta?.transform && !base.transform ? { ...base, transform: rawMeta.transform } : base,
        optionsRevision: '',
        themeRevision: '',
        actionKeys: lazyActionKeys((fields.nav as readonly FamilyNavTuple[] | undefined) ?? EMPTY_NAV, installedHour),
        accessibleDescription: typeof fields.accessibleDescription === 'string' ? fields.accessibleDescription : null,
        ...(installedAuditId !== undefined ? { auditId: installedAuditId } : {}),
      };
      const record = recordInstalled(installed, fields, selectionsRef.current.at(installed.generation.binding));
      recordRef.current = record;
      if (cur.onFollowedTileRanks && !shown.dim) {
        cur.onFollowedTileRanks(installedHour, installed.validInterval, fields[TILE_ROSTER_FIELD] as TileRosters | undefined);
      }
      if (lastHoverHourRef.current !== null) publishHoverHour(lastHoverHourRef.current);
      const rawSummary = rawMeta?.empty ? null : resolveHeaderSummary({
        summaryText: rawMeta?.summaryText ?? null,
        summaryPartial: rawMeta?.summaryPartial ?? null,
        notes: rawMeta?.notes ?? NO_STRINGS,
      });
      describe(mergeAccessibleDescription(installed.accessibleDescription, rawSummary));

      const extentSize = activeAdapter.getScrollExtent?.(fields);
      if (extentSize) {
        if (extentSize.width !== undefined) {
          const width = Math.max(viewportRef.current.width, extentSize.width);
          if (lastExtentRef.current.width !== width) {
            lastExtentRef.current.width = width;
            mounted.extent.style.width = `${width}px`;
          }
        }
        if (extentSize.height !== undefined) {
          const geometry = computeScrollGeometry(extentSize.height, viewportRef.current.height);
          scrollGeometryRef.current = geometry;
          if (lastExtentRef.current.height !== geometry.physicalHeight) {
            lastExtentRef.current.height = geometry.physicalHeight;
            mounted.extent.style.height = `${geometry.physicalHeight}px`;
          }
        }
      }

      const [defW, defH] = activeAdapter.defaultSize ?? [320, 200];
      const vp = viewportRef.current;
      const installedViewport: FamilyViewportState = {
        width: vp.width || defW,
        height: vp.height || defH,
        dpr: vp.dpr,
        scrollLeft: vp.scrollLeft,
        scrollTop: physicalToLogicalTop(vp.scrollTop, scrollGeometryRef.current),
        zoomWindow: vp.zoomWindow,
      };
      const anchored = anchoredWindowRef.current;
      if (anchored) {
        const nextWindow = anchoredRowWindow(anchored, fields.table as TableOrdinalMetrics | undefined);
        const changed = !sameRowWindow(requestedWindowRef.current, nextWindow);
        const requested = changed ? nextWindow : requestedWindowRef.current;
        requestedWindowRef.current = requested;
        const report = nextReportedRowWindow(windowRef.current, requested, installed.hour, cur.plan);
        if (report) {
          windowRef.current = report;
          cur.onWindowChange?.(report.window, report.hour);
        }
        if (changed) queueMicrotask(() => showViewRef.current());
      } else {
        const installedUpdate = reconcileInstalledRowWindow(
          windowRef.current,
          requestedWindowRef.current,
          activeAdapter,
          cur.plan,
          installedViewport,
          cur.settings,
          fields,
          installed.hour,
        );
        requestedWindowRef.current = installedUpdate.requested;
        if (!installedUpdate.requested) {
          windowRef.current = null;
        } else if (installedUpdate.report) {
          windowRef.current = installedUpdate.report;
          cur.onWindowChange?.(installedUpdate.report.window, installedUpdate.report.hour);
        }
        if (installedUpdate.changed) queueMicrotask(() => showViewRef.current());
      }

      if (activeAdapter.chromeState) {
        const nextChrome = activeAdapter.chromeState(fields, chromeStateRef.current);
        if (nextChrome !== chromeStateRef.current) {
          chromeStateRef.current = nextChrome;
          setChromeState(nextChrome);
        }
      }

      const table = fields.table as TableOrdinalMetrics | undefined;
      if (table && table !== lastTableRef.current) {
        lastTableRef.current = table;
        const hovered = inspectedKeyRef.current;
        if (hovered && !record.nav.some(entry => entry[0] === hovered)) clearHoverRef.current();
      }
      let pendingFocused = false;
      const pendingOrdinal = pendingOrdinalRef.current;
      if (pendingOrdinal !== null) {
        if (!table || fields.panes || table.count <= 0 || pendingOrdinal >= table.count) {
          pendingOrdinalRef.current = null;
        } else {
          const entry = resolveInstalledOrdinal(
            record.nav,
            pendingOrdinal,
            table,
            requestedWindowRef.current,
            fields.mirror as MirrorModel | undefined,
            record.picture.actionKeys,
          );
          if (entry) {
            if (entry[2] < pendingOrdinal && requestedWindowRef.current) {
              anchoredWindowRef.current = { first: requestedWindowRef.current.first, count: requestedWindowRef.current.count };
            }
            pendingOrdinalRef.current = null;
            focusedKeyRef.current = entry[0];
            lastFocusNavRef.current = record.nav;
            revealRow(entry);
            pendingFocused = true;
          }
        }
      }
      publishFocusKey();
      if (pendingOrdinalRef.current === null && focusInsideRef.current && focusedKeyRef.current && navNow() !== lastFocusNavRef.current) {
        lastFocusNavRef.current = navNow();
        const focusedKey = focusedKeyRef.current;
        const entry = navNow().find(item => item[0] === focusedKey);
        if (entry && revealRow(entry)) queueMicrotask(() => bindRef.current());
      }

      const clockSnap = runtime.clock.getSnapshot();
      const seekSeq = clockSnap.seekSequence ?? 0;
      const seekChanged = !shown.dim && lastMirrorSeekRef.current !== seekSeq;
      const incomingMirror = fields.mirror as MirrorModel | undefined;
      const hostMirrorEmpty = (lastMirrorObjRef.current?.rows.length ?? 0) === 0;
      const gainedFirstRow =
        hostMirrorEmpty
        && ((incomingMirror?.rows.length ?? 0) > 0 || (!lastMirrorHadSourceRowsRef.current && hasInstalledRows(record)));
      const shouldSyncMirror =
        !clockSnap.playing
        || focusInsideRef.current
        || pendingFocused
        || seekChanged
        || lastMirrorHourRef.current === null
        || gainedFirstRow;
      if (shouldSyncMirror) {
        commitMirrorRef.current(record, pendingFocused, seekSeq, !shown.dim);
      } else {
        const el = mirrorElement();
        if (el) {
          const isTable = (activeAdapter.mirror ?? 'none') === 'table';
          const nextMirror = incomingMirror ?? null;
          const desiredCaption = isTable && !latestRef.current.blocked && metaRef.current.mode === 'picture' && !metaRef.current.empty
            ? (resolveHeaderSummary(metaRef.current)?.spoken ?? null)
            : null;
          const stale =
            lastMirrorHourRef.current !== installedHour
            || nextMirror !== lastMirrorObjRef.current
            || record.selectedKey !== lastMirrorSelectedRef.current
            || (isTable && table !== undefined && table.count !== lastRowCountRef.current)
            || (isTable && desiredCaption !== lastMirrorCaptionRef.current);
          if (stale) {
            holdElement(el, true, MIRROR_HOLD);
          }
        }
      }
      if (pendingFocused) {
        if ((activeAdapter.mirrorFocus ?? 'body') === 'rows' && focusedKeyRef.current) {
          const tr = mirrorBodyRef.current?.querySelector<HTMLTableRowElement>(mirrorRowSelector(focusedKeyRef.current));
          if (tr && document.activeElement !== tr) {
            focusInsideRef.current = true;
            restoringFocusRef.current = true;
            try {
              for (const sibling of mirrorBodyRef.current!.querySelectorAll<HTMLTableRowElement>('tr[tabindex="0"]')) {
                if (sibling !== tr) sibling.tabIndex = -1;
              }
              tr.tabIndex = 0;
              tr.focus({ preventScroll: true });
            } finally {
              restoringFocusRef.current = false;
            }
          }
        }
        queueMicrotask(() => bindRef.current());
      }

      const phases = fields.phases;
      if (perfLog && phases && phases !== lastPhasesRef.current && frameNode) {
        lastPhasesRef.current = phases;
        frameNode.dataset.familyPhases = JSON.stringify(phases);
      }

      const inspected = inspectedKeyRef.current;
      const focusInside = focusInsideRef.current;
      if (!inspected && !focusInside) {
        tooltips.hideIfUnpinned();
        return;
      }
      const hoverTip = inspected ? (fields.tooltip as FamilyTooltipField | undefined) : undefined;
      const focusTip = focusInside ? (fields.focusTooltip as FamilyTooltipField | undefined) : undefined;
      if (focusTip?.text && (activeAdapter.mirrorFocus ?? 'body') === 'rows' && focusTip.text.rowKey === focusedKeyRef.current) {
        const tr = mirrorBodyRef.current?.querySelector<HTMLTableRowElement>(mirrorRowSelector(focusTip.text.rowKey));
        tr?.setAttribute('aria-description', tooltips.describeFocused(focusTip.text, installedHour, cur.viewportHeight));
      }
      const inspectedHit = inspectedHitRef.current;
      tooltips.syncFromInstall({
        dim: !!shown.dim,
        held: heldRef.current,
        inspectedKey: inspected,
        inspectedToken: inspectedHit ? (inspectedHit.inspectToken ?? familyInspectToken(activeAdapter, inspectedHit.key)) : null,
        pointerPos: lastPointerRef.current,
        hoverTip: hoverTip?.text ?? null,
        hoverFieldKey: hoverTip?.key ?? null,
        keepHoverWhilePending: (activeAdapter.pointerMode ?? 'discrete') === 'continuous',
        focusInside,
        focusedKey: focusedKeyRef.current,
        focusAnchor: focusAnchorRef.current,
        focusTip: focusTip?.text ?? null,
        viewportHeight: cur.viewportHeight,
      });
    };

    install();
    const stopInstall = pipeline.onInstall(pipe, install);
    const resolveInstalled = () => {
      const shown = pipeline.view(pipe);
      const shownId = shown?.mode === 'picture' ? shown.id : undefined;
      if (shownId !== recordRef.current?.picture?.id) install();
      return recordRef.current?.picture ?? null;
    };
    resolveInstalledRef.current = resolveInstalled;

    const gestures = mountAdapter.gestures;
    const stopPointer = bindFamilyPointer({
      bodyNode: node,
      pictureNode: mounted.canvas,
      menuHost: frameRef.current ?? node,
      pipeline,
      pipe,
      tooltips,
      inspectedKeyRef,
      inspectedHitRef,
      lastPointerRef,
      focusInsideRef,
      focusedKeyRef,
      focusAnchorRef,
      accessibleRef: (mountAdapter.mirror ?? 'none') === 'table' ? accessibleTableRef : (mountAdapter.mirror ?? 'none') === 'listbox' ? listboxMirrorRef : bodyRef,
      pointerMode,
      playbackHover: mountAdapter.family === 'bars',
      isBlocked: () => inputBlocked(gateNow()),
      getInstalled: resolveInstalled,
      getViewportHeight: () => latestRef.current.viewportHeight,
      parseHit: hitKey => parseFamilyHit(latestRef.current.adapter, hitKey),
      inspectToken: key => familyInspectToken(latestRef.current.adapter, key),
      onHoverChange: hit => publishHoverHour(hit?.hour ?? null),
      onHoverHit: publishHoverRow,
      ...(gestures
        ? {
            gestures: {
              ...(gestures.onWheel ? { onWheel: (event: WheelEvent, point: readonly [number, number]) => gestures.onWheel!(event, point, gestureContext()) } : {}),
              ...(gestures.onDragStart ? { onDragStart: (point: readonly [number, number]) => gestures.onDragStart!(point, gestureContext()) } : {}),
              ...(gestures.onDragMove ? { onDragMove: (point: readonly [number, number], delta: readonly [number, number]) => gestures.onDragMove!(point, delta, gestureContext()) } : {}),
              ...(gestures.onDragEnd ? { onDragEnd: () => gestures.onDragEnd!(gestureContext()) } : {}),
              ...(gestures.onDoubleClick ? { onDoubleClick: (point: readonly [number, number]) => gestures.onDoubleClick!(point, gestureContext()) } : {}),
            },
          }
        : {}),
      rowDrag: {
        starts: hit => {
          const row = hit.kind === 'region-grip' && latestRef.current.onRegions
            ? regionRowOf(fieldsNow().regions as RegionRowsField | undefined, hit.key)
            : null;
          regionDragRef.current = row;
          return row !== null;
        },
        move: point => {
          const row = regionDragRef.current;
          const field = fieldsNow().regions as RegionRowsField | undefined;
          const line = regionDropRef.current;
          if (!line) return;
          const drop = row && field ? regionDropAt(field, row, point[1] + viewportRef.current.scrollTop) : null;
          line.hidden = drop === null;
          if (drop) line.style.top = `${Math.round(drop.lineY - viewportRef.current.scrollTop) - 1}px`;
        },
        end: point => {
          const row = regionDragRef.current;
          const field = fieldsNow().regions as RegionRowsField | undefined;
          const send = latestRef.current.onRegions;
          regionDragRef.current = null;
          if (regionDropRef.current) regionDropRef.current.hidden = true;
          if (!row || !field || !point || !send) return;
          const drop = regionDropAt(field, row, point[1] + viewportRef.current.scrollTop);
          if (!drop) return;
          const message = send({ op: 'drop', row, to: drop.to });
          if (message) say(message);
        },
      },
      onActivate: (key, toggle, hit, picture) => { dispatch(toggle ? 'toggle' : 'activate', { key, hit, picture }); },
      onContextMenu: (key, clientX, clientY, hit, picture) => dispatch('menu', { key, hit: hit ?? null, picture: picture ?? null, at: { x: clientX, y: clientY } }),
    });
    clearHoverRef.current = stopPointer.clearHover;

    const onScroll = scrollMode !== 'none'
      ? () => {
          const left = Math.floor(node.scrollLeft);
          const top = Math.floor(node.scrollTop);
          if (left === viewportRef.current.scrollLeft && top === viewportRef.current.scrollTop) return;
          pendingOrdinalRef.current = null;
          anchoredWindowRef.current = null;
          viewportRef.current.scrollLeft = left;
          viewportRef.current.scrollTop = top;
          showViewRef.current();
        }
      : null;
    if (onScroll) node.addEventListener('scroll', onScroll, { passive: true });

    bindRef.current();

    return () => {
      pendingOrdinalRef.current = null;
      anchoredWindowRef.current = null;
      resolveInstalledRef.current = () => recordRef.current?.picture ?? null;
      describe(null);
      if (onScroll) node.removeEventListener('scroll', onScroll);
      clearHoverRef.current = () => {};
      stopPointer();
      stopInstall();
      if (frameRef.current?.playbackDiagnostics) delete frameRef.current.playbackDiagnostics.installedBinding;
      auditWatch.dispose();
      clearMirrorRef.current();
      recordRef.current = null;
      if (lastInstalledHourRef.current !== null) {
        lastInstalledHourRef.current = null;
        latestRef.current.onInstalledHour?.(null);
      }
      publishHoverHour(null);
      publishFocusKey();
      unregisterShared?.();
      mounted.unmount();
      surfaceRef.current = null;
      holdElement(frameRef.current, false);
      reportFamilyShownHour(reportShownRef.current, false, null);
      exportReportRef.current?.(`${widget.id}:${instanceId}`, null);
    };
  }, [pipeline, pipe, instanceId, widget.id, tooltips, scrollMode, pointerMode, gestureContext, dispatch, gateNow, publishHoverHour, reportWindow, runtime.clock, mirrorElement, sharedHost, useShared]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const box = { width: node.clientWidth, height: node.clientHeight };
    const measure = (observed = false) => {
      refreshFocusAnchor();
      const fit = deviceFit(node, box.width, box.height);
      const vp = viewportRef.current;
      const canMeasure = observed || typeof ResizeObserver === 'function';
      const newlyMeasured = canMeasure && !measuredRef.current;
      if (canMeasure) measuredRef.current = true;
      if (!newlyMeasured && fit.width === vp.width && fit.height === vp.height && fit.dpr === vp.dpr) return;
      vp.width = fit.width;
      vp.height = fit.height;
      vp.dpr = fit.dpr;
      anchoredWindowRef.current = null;
      if (latestRef.current.hasChrome) setChromeWidth(fit.width);
      notifyViewportChange();
      sharedHost?.scheduleSync();
      bindRef.current();
    };
    measure();
    const stopRatio = watchDevicePixelRatio(() => measure());
    if (typeof ResizeObserver !== 'function') return stopRatio;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      box.width = rect ? rect.width : node.clientWidth;
      box.height = rect ? rect.height : node.clientHeight;
      measure(true);
    });
    observer.observe(node);
    return () => {
      stopRatio();
      observer.disconnect();
    };
  }, [notifyViewportChange, refreshFocusAnchor, sharedHost]);

  useLayoutEffect(() => {
    pendingOrdinalRef.current = null;
    anchoredWindowRef.current = null;
  }, [plan, declaration, view, options, settings]);

  useLayoutEffect(() => {
    if (pipe !== null && enabled) bind();
  }, [
    pipe,
    enabled,
    bind,
    declaration,
    view,
    options,
    theme,
    reducedMotion,
    extent,
    plan,
    selectedKey,
    subsReady,
    auditable,
    exactReadView,
    audit.captureActive,
    settings,
    exportSurface.motion,
  ]);

  const supplyData = useCallback(() => {
    supply?.data(supplyDataFields(latestRef.current));
  }, [supply]);
  const supplyArt = useCallback(() => {
    if (perfLog && latestRef.current.captureActive) showViewRef.current();
    else supply?.data(supplyArtFields(latestRef.current), 'art');
  }, [supply]);
  useLayoutEffect(() => {
    supplyData();
  }, [supplyData, tiledBySource, hovers, pagedRows]);
  useLayoutEffect(() => {
    supplyArt();
  }, [supplyArt, laneArt]);

  useLayoutEffect(() => {
    supply?.statics(staticSources, datedNow());
  }, [supply, staticSources, resolvedOwner, datedNow]);

  useLayoutEffect(() => {
    if (!pipeline || pipe === null) return;
    pipeline.supply(pipe, { identity: identitySnapshot });
  }, [pipeline, pipe, identitySnapshot]);

  useLayoutEffect(() => laneArt?.subscribe(supplyArt), [laneArt, supplyArt]);

  useLayoutEffect(() => staticProof?.subscribe(supplyDated), [staticProof, supplyDated]);

  useFamilyPauseFlush(runtime.clock, () => {
    if (!pipeline || pipe === null) return;
    const record = recordRef.current;
    if (record?.fields.mirror !== undefined) {
      const seekSeq = runtime.clock.getSnapshot().seekSequence ?? 0;
      commitMirrorRef.current(record, false, seekSeq, !pipeline.view(pipe)?.dim);
    }
    pauseFlushRef.current++;
    bindRef.current();
  });

  useEffect(() => {
    if (!onDiagnostics) return;
    const { warnings, notes } = metaRef.current;
    onDiagnostics(mergeDiagnosticNotes(extraWarnings, warnings, notes));
    return () => onDiagnostics([]);
  }, [onDiagnostics, extraWarnings]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const priorPending = pendingOrdinalRef.current;
    if (event.key !== 'Shift' && event.key !== 'Control' && event.key !== 'Alt' && event.key !== 'Meta') {
      pendingOrdinalRef.current = null;
    }
    const picture = resolveInstalledRef.current();
    const activeAdapter = latestRef.current.adapter;
    const gate = gateNow();
    const fields = gate.current?.fields ?? EMPTY_FIELDS;
    const keyNav = gate.current?.nav ?? EMPTY_NAV;
    const blocked = inputBlocked(gate);
    const run = (command: HostCommand, key: string | null) => {
      refreshFocusAnchor();
      return dispatch(command, { key, hit: null, picture });
    };
    const unpin = () => tooltips.unpin(say);

    if (activeAdapter.navigation === 'grid') {
      const metrics = activeAdapter.getGridMetrics?.(fields);
      const parseKey = activeAdapter.parseGridKey ?? parseGridKey;
      const formatKey = activeAdapter.formatGridKey ?? formatGridKey;
      handleFamilyGridKeyDown(event, {
        rows: metrics?.rows ?? 0,
        columns: metrics?.columns ?? 0,
        current: parseKey(focusedKeyRef.current) ?? { row: 0, column: 0 },
        pageStep: metrics ? Math.max(1, Math.floor(Math.max(1, viewportRef.current.height - metrics.gridTop) / Math.max(1, metrics.cellSize))) : 1,
        blocked,
        isPinnedTooltip: () => tooltips.isPinned(),
        onFocusCell: focusGridCell,
        onActivate: (row, column) => { run('activate', formatKey(row, column)); },
        onContextMenu: (row, column) => run('menu', row >= 0 && column >= 0 ? formatKey(row, column) : null),
        onTogglePinTooltip: (row, column) => { run('pin', formatKey(row, column)); },
        onUnpinTooltip: unpin,
      });
      return;
    }

    if (activeAdapter.navigation === 'points') {
      const pointsNav = latestRef.current.onPointsNavigate;
      handleFamilyPointsKeyDown(event, {
        nav: keyNav,
        focusedKey: focusedKeyRef.current,
        pageStep: DEFAULT_POINTS_PAGE,
        blocked,
        isPinnedTooltip: () => tooltips.isPinned(),
        onFocusKey: key => {
          focusEpochRef.current++;
          clearHoverRef.current();
          focusedKeyRef.current = key;
          const hour = parseFamilyHit(activeAdapter, key)?.hour;
          if (hour !== undefined) publishHoverHour(hour);
          bindRef.current();
        },
        ...(pointsNav ? {
          onPointsNavigate: key => {
            const currentHour = parseFamilyHit(activeAdapter, focusedKeyRef.current)?.hour ?? null;
            const epoch = ++focusEpochRef.current;
            return pointsNav({
              key,
              currentHour,
              zoomWindow: viewportRef.current.zoomWindow ?? null,
              focusHour: hour => {
                if (focusEpochRef.current !== epoch || !focusInsideRef.current) return;
                clearHoverRef.current();
                focusedKeyRef.current = `plot:${hour}`;
                publishHoverHour(hour);
                bindRef.current();
              },
            });
          },
        } : {}),
        onActivate: entry => { run('activate', entry[0]); },
        onContextMenu: entry => run('menu', entry ? entry[0] : null),
        onTogglePinTooltip: key => { run('pin', key); },
        onUnpinTooltip: unpin,
      });
      return;
    }

    const sendRegions = latestRef.current.onRegions;
    const regionRow = sendRegions && !blocked ? regionRowOf(fields.regions as RegionRowsField | undefined, focusedKeyRef.current) : null;
    if (sendRegions && regionRow && (event.key === 'Delete' || (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')))) {
      event.preventDefault();
      const message = event.key === 'Delete'
        ? sendRegions({ op: 'remove', row: regionRow })
        : sendRegions({ op: 'step', row: regionRow, delta: event.key === 'ArrowUp' ? -1 : 1 });
      if (message) say(message);
      return;
    }

    const table = fields.table as TableOrdinalMetrics | undefined;
    const pagedTable = !!table && !fields.panes && requestedWindowRef.current !== null;
    const focusedKey = priorPending !== null ? null : focusedKeyRef.current;
    const rowViewportHeight = usableRowHeight(fields, viewportRef.current.height);
    const currentOrdinal = priorPending !== null
      ? priorPending
      : (focusedKey !== null ? keyNav.find(item => item[0] === focusedKey)?.[2] : undefined) ?? 0;

    handleFamilyKeyDown(event, {
      nav: keyNav,
      ...(pagedTable
        ? {
            totalCount: table.count,
            ...(priorPending !== null ? { focusedIndex: priorPending } : {}),
            onFocusOrdinal: focusRowByOrdinal,
          }
        : {}),
      focusedKey,
      pageStep: pagedTable
        ? tablePageSteps(table, keyNav, currentOrdinal, rowViewportHeight, configuredTableRowHeight(fields, latestRef.current.settings))
        : navPageSteps(keyNav, focusedKey, rowViewportHeight),
      blocked,
      typeaheadRef,
      isPinnedTooltip: () => tooltips.isPinned(),
      onFocusKey: focusRowByKey,
      onActivate: entry => { run('activate', entry[0]); },
      onToggleTree: key => { run('toggle', key); },
      onContextMenu: entry => run('menu', entry ? entry[0] : null),
      onTogglePinTooltip: key => { run('pin', key); },
      onUnpinTooltip: unpin,
    });
  }, [say, dispatch, gateNow, focusGridCell, focusRowByKey, focusRowByOrdinal, publishHoverHour, refreshFocusAnchor, tooltips]);

  const onFocus = useCallback(() => {
    pendingOrdinalRef.current = null;
    focusInsideRef.current = true;
    refreshFocusAnchor();
    const activeAdapter = latestRef.current.adapter;
    if (!focusedKeyRef.current) {
      if (activeAdapter.navigation === 'grid') {
        const metrics = activeAdapter.getGridMetrics?.(fieldsNow());
        if (metrics && metrics.rows > 0 && metrics.columns > 0) focusedKeyRef.current = (activeAdapter.formatGridKey ?? formatGridKey)(0, 0);
      } else if (!(activeAdapter.navigation === 'points' && latestRef.current.onPointsNavigate) && navNow().length) {
        focusedKeyRef.current = navNow()[0]![0];
      }
    }
    const record = recordRef.current;
    if (record?.fields.mirror !== undefined) {
      const seekSeq = runtime.clock.getSnapshot().seekSequence ?? 0;
      const settled = !(pipeline && pipe !== null && pipeline.view(pipe)?.dim);
      commitMirrorRef.current(record, true, seekSeq, settled);
    }
    bindRef.current();
  }, [refreshFocusAnchor, runtime.clock, pipeline, pipe]);

  const onBlur = useCallback(() => {
    focusEpochRef.current++;
    pendingOrdinalRef.current = null;
    focusInsideRef.current = false;
    if (latestRef.current.onPointsNavigate) focusedKeyRef.current = null;
    if (!inspectedKeyRef.current) tooltips.hideIfUnpinned();
    bindRef.current();
  }, [tooltips]);

  const onRowFocus = useCallback((event: ReactFocusEvent<HTMLTableElement>) => {
    if (restoringFocusRef.current) return;
    pendingOrdinalRef.current = null;
    const wasInside = focusInsideRef.current;
    focusInsideRef.current = true;
    refreshFocusAnchor();
    const row = (event.target as HTMLElement | null)?.closest<HTMLTableRowElement>('tr[data-row-key]');
    const keyChanged = !!row?.dataset.rowKey && (!wasInside || focusedKeyRef.current !== row.dataset.rowKey);
    if (keyChanged) focusedKeyRef.current = row.dataset.rowKey!;
    const record = recordRef.current;
    if (record?.fields.mirror !== undefined && (!wasInside || lastMirrorHourRef.current !== record.picture.hour || record.fields.mirror !== lastMirrorObjRef.current)) {
      const seekSeq = runtime.clock.getSnapshot().seekSequence ?? 0;
      const settled = !(pipeline && pipe !== null && pipeline.view(pipe)?.dim);
      commitMirrorRef.current(record, true, seekSeq, settled);
    }
    if (keyChanged || !wasInside) bindRef.current();
  }, [refreshFocusAnchor, runtime.clock, pipeline, pipe]);

  const onRowBlur = useCallback((event: ReactFocusEvent<HTMLTableElement>) => {
    if (restoringFocusRef.current) return;
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    pendingOrdinalRef.current = null;
    focusInsideRef.current = false;
    if (!inspectedKeyRef.current) tooltips.hideIfUnpinned();
    bindRef.current();
  }, [tooltips]);

  const onRetryLocal = useCallback(() => retryLocal(() => bindRef.current()), [retryLocal]);

  const bodyStateNode = blockedState ?? renderFamilyBodyState({
    mode: meta.mode,
    reason: meta.reason,
    failureOrigin: meta.failureOrigin,
    empty: meta.empty,
    emptyDetail: meta.emptyDetail,
    emptyKind: meta.emptyKind,
    subject,
    loadingLabel,
    pipeline,
    pipe,
    onRetryStream: retryStream,
    onRetryLocal,
    emptyAction: typeof emptyAction === 'function' ? emptyAction(openRegionsAt) : emptyAction,
  });

  const hasBodyState = Boolean(bodyStateNode);
  const keepRefusedCanvas = !blockedState && meta.mode === 'picture' && meta.playbackUnavailable === true;
  useLayoutEffect(() => {
    if (useShared && sharedHost && pipe !== null) {
      sharedHost.setActive(pipe, !hasBodyState || keepRefusedCanvas);
    }
  }, [useShared, sharedHost, pipe, hasBodyState, keepRefusedCanvas]);

  const headerSummary = meta.mode === 'picture' && !meta.empty && !bodyStateNode
    ? resolveHeaderSummary(metaRef.current)
    : null;
  useLayoutEffect(() => {
    syncHeaderSummary(headerSummaryRef.current, headerSummary);
  }, [headerSummary, headerSlot]);
  const rowsFocus = (adapter.mirrorFocus ?? 'body') === 'rows';
  const bodyRole = mirrorKind === 'listbox' ? 'listbox' : adapter.navigation === 'grid' ? 'grid' : 'region';
  const bodyFocus = rowsFocus
    ? {}
    : { tabIndex: blockedState ? -1 : 0, role: bodyRole, 'aria-label': label, onFocus, onBlur, onKeyDown };

  useLayoutEffect(() => {
    syncTableTabIndex(Boolean(lastMirrorObjRef.current?.rows.some(r => !r.groupHeader)));
    if (blockedState && accessibleTableRef.current?.caption) {
      accessibleTableRef.current.deleteCaption();
      lastMirrorCaptionRef.current = null;
    }
  }, [blockedState, rowsFocus, syncTableTabIndex]);

  useLayoutEffect(() => {
    if (!perfLog || !frameRef.current) return;
    const diagnostics = frameRef.current.playbackDiagnostics ??= {};
    diagnostics.bodyStatus = bodyStatus ?? (blockedState ? 'blocked' : 'ready');
    diagnostics.metaMode = meta.mode;
  }, [bodyStatus, blockedState, meta.mode]);

  return (
    <div ref={frameRef} data-tooltip-owner={tooltipOwner} className={className ? `fh-frame ${className}` : 'fh-frame'}>
      {headerSlot && headerSummary ? createPortal(<FamilyHeaderSummary ref={headerSummaryRef} summary={headerSummary} />, headerSlot) : null}
      {Chrome ? (
        <Chrome
          state={chromeState}
          meta={meta}
          settings={settings}
          {...(onSettings ? { onSettings } : {})}
          editable={editableSettings}
          viewportWidth={chromeWidth}
          bodyBlocked={!!bodyStateNode}
          announce={say}
          targets={targets}
          shownHour={() => recordRef.current?.picture.hour ?? null}
          filterSlot={filterSlot}
          setFilterOption={setFilterOption}
          headerSlot={headerSlot}
        />
      ) : null}
      <div ref={bodyWrapRef} className="fh-body-wrap">
        <div
          ref={bodyRef}
          className={scrollMode === 'none' ? 'fh-body' : 'fh-body themed-scrollbar'}
          data-scroll={scrollMode}
          data-family={adapter.family}
          data-clickable={onActivate ? 'true' : undefined}
          {...bodyFocus}
        >
          {mirrorKind === 'listbox' ? <div ref={listboxMirrorRef} className="fh-sr-only" /> : null}
        </div>
        <div ref={regionDropRef} className="fh-region-drop" hidden />
        {bodyStateNode ? <div className="fh-overlay">{bodyStateNode}</div> : null}
      </div>
      <div ref={descriptionRef} id={`${adapter.family}-${instanceId}-description`} className="fh-sr-only" />
      {mirrorKind === 'table' ? (
        <table
          ref={accessibleTableRef}
          className="fh-sr-only"
          aria-label={label}
          role={adapter.tree ? 'treegrid' : undefined}
          {...(rowsFocus ? { onFocus: onRowFocus, onBlur: onRowBlur, onKeyDown } : {})}
        >
          <thead ref={mirrorHeadRef} />
          <tbody ref={mirrorBodyRef} />
        </table>
      ) : null}
      {!hasFrame ? <div ref={liveRegionRef} className="fh-sr-only" role="status" aria-live="polite" aria-atomic="true" /> : null}
      {contextMenu.menu}
    </div>
  );
}
