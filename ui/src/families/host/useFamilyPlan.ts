import { createExactReadView, emptyPagers, NO_PAGED_SNAPSHOT, pagedEntries, pagedSnapshots, pagerWindow, replacePagers, type PagedSnapshot, type PagerSet } from './pagers.ts';
import { NO_TILED_SERIES, chartTileLane, reuseTiledSeries, reuseTileUnrecorded, topTileProof, type HeldTileUnrecorded } from './tiledState.ts';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { IconName } from '../../components/Icons';
import { validateProductReply } from '../../dashboard/client.ts';
import { countryFromKey, isSlotKey } from '../../dashboard/countryKey.ts';
import { countryIdentityIndex, validCountryIdentityHistories } from '../../dashboard/countryIdentity.ts';
import { heldCountryNameAt } from '../../dashboard/countryNamesAt.ts';
import { selectedCountryKeys } from '../../dashboard/countrySelection';
import type { WidgetRuntime } from '../../dashboard/definitions';
import { usePlaybackHour } from '../../dashboard/follow/useFollow.ts';
import { revisionOf } from '../../dashboard/follow/payloads.ts';
import { useContentRevision } from '../../dashboard/contentRevision.ts';
import { inFrame } from '../../dashboard/frameUpdates.ts';
import { countryMatch, countryMatchChangeHours, EVER_UNRECORDED, everBounds, everStateAt, groupUnobserved, membershipUnrecordedAt, noMembersAt, rankedCandidates, resolveCountries, worldFilter } from '../../dashboard/groups';
import { cumulativeEverMembership, datedIdentityMembership, groupSpanBodyStatus, groupSpanCover, groupSpanStateAt, incompleteGroupBodyStatus, incompleteHourStateAt, staticDatedGroupBodyStatus } from '../groupFilter.ts';
import { resolveWindow, type WidgetBase } from '../../dashboard/model';
import { nameReadText } from '../../dashboard/nameReads.ts';
import { NO_MEMBERS } from '../../dashboard/noMembers.ts';
import type { OptionValue } from '../../dashboard/options';
import { loadProduct, peekProduct, productKey, useProduct } from '../../dashboard/products';
import { asFailure, type Failure } from '../../dashboard/queryError.ts';
import { useCountryNameAt } from '../../dashboard/reachedProduct';
import { useGate, type Holder } from '../../dashboard/regionGate';
import { axisAt, coverageAt, coverageSpan, lastRecordedHour, SPEC } from '../../dashboard/regionTime';
import { productRequest } from '../../dashboard/request.ts';
import { TileView, tileCache, type TiledLine, type TileRosters, type TileViewport } from '../../dashboard/tiles/view.ts';
import { useCountryGroups } from '../../dashboard/useCountryGroups';
import { countRead, measuredWidget } from '../../dashboard/widgetPerf.ts';
import { useRegion, useRegionCoverage, watchBoundary } from '../../dashboard/widgetTime';
import { StripPageContext, type StripWidget } from '../../dashboard/strip/driver.ts';
import { perfLog } from '../../shell/perf.ts';
import type { FamilyStaticProof } from './adapter.ts';
import { createExactArtProvider, type ArtResolutions } from '../art/provider.ts';
import {
  buildExactRequests,
  buildStripKeyframe,
  buildTailPageRequest,
  compileFollowPlan,
  currentHovers,
  exactEntries,
  FamilySourceBroker,
  hoverAsks,
  type HeldHover,
  type HoverAsk,
  stabilizeCanvasDimension,
} from '../broker.ts';
import { identitySnapshots } from './identitySnapshots.ts';
import { allReady, familyBodyStatus, inputOf, type PlanInput } from './planInputs.ts';
import { displayedHoverKeys, type DrawnKeys } from './installed.ts';
import { holdDayTiles } from '../heat/dayTiles.ts';
import { gatedByCountry, plannedRangeSpan, plannedSignature, planFamilySources, stripContextAt, stripPlanKey, watchPlanValid } from './planSources.ts';
import type { HolderRun } from '../holders.ts';
import { overlapsHourRanges } from '../holders.ts';
import { identityBrokerFor } from '../identity/broker.ts';
import { createBrokerIdentityProvider, parseEntityKey } from '../identity/provider.ts';
import {
  useIdentities,
  useIdentityScope,
  useSlotIndex,
  type IdentityAsk,
  type IdentitySnapshot,
} from '../identity/react.ts';
import type {
  AuxProductSpec,
  BoundedReadView,
  CompiledFollowSubscription,
  CountryPolicy,
  DeclaredCountryFilter,
  DeclaredCountryState,
  EntityKind,
  FamilyBodyStatus,
  FamilyPlanContext,
  FamilyViewportRequest,
  IdentityProvider,
  SourceEntry,
  SourcePlan,
} from '../plan.ts';
import {
  ReadTarget,
  showBundle,
  shownView,
  unitEntries,
  type PinnedAsk,
  type ShownBundle,
  type TargetView,
} from '../readUnits.ts';
import {
  effectiveCountryUnobserved,
  extractFactionData,
  freezeGate,
  planOwner,
  trackGate,
  type FrozenGate,
} from '../sources.ts';
import { resolveSelectedCountryRefs } from '../table/logHelpers.ts';
import {
  validateGenericTailReply,
  type PagedRows,
} from '../table/rowSource.ts';
import type { FamilyRowWindow } from './adapter.ts';

const NO_TAGS: readonly string[] = [];
const NO_SERIES: Readonly<Record<string, ReadonlyMap<string, TiledLine>>> = {};
const EVERY_COUNTRY: DeclaredCountryFilter = { passing: null, unrecorded: [], bounds: [] };
const filterCache = new WeakMap<object, Map<string, DeclaredCountryFilter>>();

function buildFilterTimeline(
  tags: readonly string[],
  matches: (tag: string, hour: number) => boolean,
  unrecordedAt: (hour: number) => string | null,
  changes: readonly number[],
  first: number,
  last: number,
): DeclaredCountryFilter {
  const bounds = [...new Set([first, ...changes.filter(at => at > first && at <= last), last + 1])].sort((a, b) => a - b);
  const passing: Record<string, [number, number][]> = {};
  const unrecorded: [number, number, string][] = [];
  for (let at = 0; at + 1 < bounds.length; at++) {
    const from = bounds[at]!, to = bounds[at + 1]! - 1;
    for (const tag of tags) if (matches(tag, from)) {
      const ranges = passing[tag] ??= [];
      const previous = ranges.at(-1);
      if (previous && previous[1] === from - 1) previous[1] = to;
      else ranges.push([from, to]);
    }
    const reason = unrecordedAt(from);
    const previous = unrecorded.at(-1);
    if (reason !== null) {
      if (previous && previous[1] === from - 1 && previous[2] === reason) previous[1] = to;
      else unrecorded.push([from, to, reason]);
    }
  }
  return { passing, unrecorded, bounds };
}

const NO_ENTRIES: readonly SourceEntry[] = [];
const NO_VIEW: TargetView = { inputs: '', kind: 'none', failure: null, bundle: null, held: false };
const NO_PIN: PinnedAsk = {
  timeMode: 'pin',
  branch: { firstHour: 0, lastHour: 0 },
  window: null,
  pinHour: null,
  gate: { recorded: () => null, span: () => null },
};

export interface StaticBundle {
  readonly stamp: object;
  readonly hour: number;
  readonly span: readonly [number, number] | null;
  readonly proof: readonly [number, number] | null;
  readonly follows?: boolean;
  readonly panels: Readonly<Record<string, unknown>>;
  readonly shifts?: Readonly<Record<string, number>>;
}

export type StaticProof = FamilyStaticProof;

export interface BannerFailureInfo {
  readonly failure: Failure;
  readonly retry: () => void;
}

export interface UseFamilyPlanInput<TAux, TExtra> {
  readonly kind: string;
  readonly subject: string;
  readonly emptyCampaign: string;
  readonly icon?: IconName;
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly countries: CountryPolicy;
  readonly aux?: AuxProductSpec<TAux>;
  readonly sources: (ctx: FamilyPlanContext<TAux>, view: FamilyViewportRequest) => SourcePlan;
  readonly captureExtra?: (ctx: FamilyPlanContext<TAux>) => TExtra;
  readonly stripProjection?: { readonly surface: string; readonly options: (ctx: FamilyPlanContext<TAux>) => unknown };
  readonly widget: WidgetBase;
  readonly runtime: WidgetRuntime;
  readonly active: boolean;
  readonly setOption?: (key: string, value: OptionValue) => void;
}

export interface UseFamilyPlanResult<TAux, TExtra> {
  readonly track: FamilyPlanContext<TAux>['track'] | undefined;
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly following: boolean;
  readonly owner: string;
  readonly ctx: FamilyPlanContext<TAux> | null;
  readonly displayedCtx: FamilyPlanContext<TAux> | null;
  readonly recorded: ReturnType<typeof useGate>['recorded'];
  readonly countryHolder: Holder | null;
  readonly displayedExtra: TExtra | undefined;
  readonly plan: SourcePlan | null;
  readonly subscriptions: readonly CompiledFollowSubscription[];
  readonly allowEmptyFollow: boolean;
  readonly followRefused: string | null;
  readonly staticBundle: StaticBundle | null;
  readonly staticProof: StaticProof;
  readonly staticHeld: boolean;
  readonly pagedRows: PagedRows | undefined;
  readonly onRowWindow: (window: FamilyRowWindow, hour: number | null) => void;
  readonly tiledSeries: Readonly<Record<string, ReadonlyMap<string, TiledLine>>>;
  readonly onSeriesViewport: (viewport: TileViewport) => void;
  readonly onFollowedTileRanks?: (hour: number, proof: readonly [number, number], ranks: TileRosters | undefined) => void;
  readonly retryTiles: () => void;
  readonly onHoverHour: (hour: number | null, keys?: DrawnKeys) => void;
  readonly hovers: Readonly<Record<string, { readonly hour: number; readonly data: unknown }>>;
  readonly exactReadView: ((hour: number, rowWindow: FamilyRowWindow | null, artResolutions?: ArtResolutions) => Promise<BoundedReadView | null>) | undefined;
  readonly stripPlan?: Pick<StripWidget, 'key' | 'fixed' | 'supported' | 'keyframe' | 'track' | 'tiles' | 'identity'> & { tilesSettled(): boolean };
  readonly bodyStatus: FamilyBodyStatus;
  readonly keepFollowingWhenBlocked?: boolean;
  readonly bannerFailure: BannerFailureInfo | null;
  readonly nameFailureDetail: string | undefined;
  readonly groupWarnings: readonly string[];
  readonly moment: number;
  readonly bounds: readonly [number, number] | null;
  readonly pin: number | null;
  readonly offset: number;
  readonly loadingLabel: string;
  readonly identitySnapshot: IdentitySnapshot | null;
  readonly identityProvider: IdentityProvider | undefined;
  readonly onIdentityDemands: (demands: readonly (readonly [EntityKind, string, number])[]) => void;
  readonly measureViewport: (width: number, height?: number) => void;
}

export function useFamilyPlan<TAux = unknown, TExtra = undefined>(
  input: UseFamilyPlanInput<TAux, TExtra>,
): UseFamilyPlanResult<TAux, TExtra> {
  const {
    kind,
    subject,
    emptyCampaign,
    options,
    countries: policy,
    aux: auxSpec,
    sources: buildSources,
    captureExtra,
    stripProjection,
    widget,
    runtime,
    active,
    setOption,
  } = input;

  const measuredViewport = useRef<{ width?: number; height?: number }>({});
  const [viewportRevision, setViewportRevision] = useState(0);

  const track = runtime.tracks.find(item => item.id === widget.trackIds[0]);
  const following = widget.time.mode === 'follow';
  const isSingle = gatedByCountry(policy, options);
  const isFilter = policy.mode === 'filter';
  const isMulti = policy.mode === 'multi';

  const gate = useGate(
    runtime,
    widget,
    SPEC,
    active,
    isSingle ? { country: { stored: options.country, setOption } } : undefined,
  );
  const coverage = useRegionCoverage(runtime, useRegion(widget));

  const singleCountry = isSingle ? gate.country! : null;
  const countryTag = isSingle && gate.open ? singleCountry!.tag : null;
  const countrySubject = isSingle && gate.open ? singleCountry!.history?.key ?? null : null;
  const countryChoice = singleCountry?.chosen ?? null;
  const countryLabel = useCountryNameAt(
    runtime.client,
    isSingle ? track : undefined,
    isSingle ? (countryTag ?? singleCountry!.chosen) : null,
    isSingle ? gate.hour : null,
    active && isSingle,
  );
  const countryName = countryLabel.name;
  const nameFailureDetail = isSingle ? countryLabel.nameFailure?.message : undefined;

  const firstHour = track?.branch.firstHour ?? 0;
  const lastHour = track?.branch.lastHour ?? 0;
  const lastRecorded = useMemo(() => lastRecordedHour(track), [track]);
  const effectiveEndHour = lastRecorded ?? lastHour;

  const playbackHour = usePlaybackHour(runtime.clock, false);
  const rawWindow = !following && track ? resolveWindow(widget, track, runtime.tracks, playbackHour) : null;
  const windowFirst = rawWindow?.firstHour ?? null;
  const windowLast = rawWindow?.lastHour ?? null;
  const window = useMemo(
    () => (windowFirst !== null && windowLast !== null ? { firstHour: windowFirst, lastHour: windowLast } : null),
    [windowFirst, windowLast],
  );
  const moment = Math.floor(window?.lastHour ?? effectiveEndHour);
  const pinHour = !following && track ? gate.hourAt(axisAt(playbackHour)) : null;

  const auxEnabled = !!auxSpec && (!auxSpec.when || auxSpec.when(options));
  const auxParams = useMemo(
    () => (auxSpec && auxEnabled && track ? auxSpec.params(track, options, countryTag, countrySubject, countryChoice) : null),
    [auxSpec, auxEnabled, track, options, countryTag, countrySubject, countryChoice],
  );
  const auxReq = useMemo(
    () => (auxSpec && auxParams && track
      ? productRequest({ sourceId: track.source.id, revision: track.source.revision, product: auxSpec.product, params: auxParams })
      : null),
    [auxSpec, auxParams, track],
  );
  const auxResult = useProduct<TAux>(
    runtime.client,
    auxReq,
    active && auxEnabled,
    auxSpec?.validate,
    track?.source,
  );

  const needsGroups = isFilter
    || (isMulti && (policy.requireGroupsWhen ? policy.requireGroupsWhen(widget, options) : widget.countries.kind === 'group'));
  const fetchGroups = isFilter || (isMulti && (needsGroups || policy.factions || policy.everyOnTop));
  const groups = useCountryGroups(runtime, track, active && fetchGroups);

  const allTagsText = useMemo(
    () => JSON.stringify((groups.data?.countryIdentities ?? []).map(history => history.tag).sort()),
    [groups.data],
  );
  const allTags = useMemo(() => (allTagsText !== '[]' ? JSON.parse(allTagsText) as string[] : NO_TAGS), [allTagsText]);

  const rawSelected = selectedCountryKeys(widget.countries, track);
  const selectedText = JSON.stringify(rawSelected);
  const selectedFallback = useMemo(() => JSON.parse(selectedText) as string[], [selectedText]);

  const filterMatch = useMemo(
    () => (isFilter ? countryMatch(widget.countries, selectedFallback, groups.data, lastHour) : null),
    [isFilter, widget.countries, selectedFallback, groups.data, lastHour],
  );
  const filter = useMemo<DeclaredCountryFilter>(() => {
    if (!isFilter || widget.countries.kind === 'all' || !filterMatch?.ready || !groups.data || !track) return EVERY_COUNTRY;
    const key = JSON.stringify([widget.countries, selectedFallback, firstHour, lastHour]);
    let held = filterCache.get(groups.data);
    if (!held) filterCache.set(groups.data, held = new Map());
    let made = held.get(key);
    if (!made) {
      made = buildFilterTimeline(
        allTags,
        filterMatch.matches,
        at => membershipUnrecordedAt(widget.countries, groups.data, at),
        countryMatchChangeHours(filterMatch.matches) ?? [],
        firstHour,
        lastHour,
      );
      held.set(key, made);
    }
    return made;
  }, [isFilter, widget.countries, filterMatch, groups.data, track, selectedFallback, allTags, firstHour, lastHour]);

  const allowsFactions = isMulti && policy.factions === true;
  const resolvedMulti = useMemo(() => {
    if (!isMulti || widget.countries.kind === 'all' || (allowsFactions && widget.countries.kind === 'factions')) return null;
    return resolveCountries(widget.countries, selectedFallback, groups.data, lastHour, Number.MAX_SAFE_INTEGER);
  }, [isMulti, allowsFactions, widget.countries, selectedFallback, groups.data, lastHour]);

  const singleSlotId = isMulti && policy.allowSingleSlot && widget.countries.kind === 'selected' && selectedFallback.length === 1
    ? countryFromKey(selectedFallback[0]!)
    : null;
  const anySlot = isMulti && policy.allowSlots && (resolvedMulti?.tags.some(isSlotKey) ?? false);
  const needsSlots = isMulti && (
    typeof singleSlotId === 'number'
    || anySlot
    || (widget.countries.kind !== 'all' && !(allowsFactions && widget.countries.kind === 'factions') && resolvedMulti?.top == null)
  );
  const identityScope = useIdentityScope(runtime.client, track?.source, track?.branch.id, active && !!track);
  const branchBounds = useMemo(
    () => (track ? [track.branch.firstHour, track.branch.lastHour] as const : undefined),
    [track?.branch.firstHour, track?.branch.lastHour],
  );
  const slotState = useSlotIndex(runtime.client, track?.source, identityScope, active && needsSlots, branchBounds);
  const slots = slotState.slots;
  const slotRevision = slotState.revision;

  const effectiveMulti = useMemo(() => {
    if (!resolvedMulti) return null;
    if (typeof singleSlotId !== 'number') return resolvedMulti;
    const runs = [...(slots?.tagRuns(singleSlotId) ?? [])];
    return {
      ...resolvedMulti,
      tags: [...new Set(runs.map(run => run.tag))],
      membership: new Map([['', runs]]),
      known: (from: number, to?: number) => !!slots && resolvedMulti.known(from, to),
    };
  }, [resolvedMulti, singleSlotId, slots, slotRevision, widget.countries, groups.data, lastHour]);

  const holders = useMemo<Readonly<Record<string, readonly HolderRun[]>> | null>(() => {
    if (!isMulti || !effectiveMulti || effectiveMulti.top != null || !slots) return null;
    const out: Record<string, readonly HolderRun[]> = {};
    for (const key of effectiveMulti.tags) out[key] = slots.runsForKey(key);
    return out;
  }, [isMulti, effectiveMulti, slots, slotRevision]);

  const unobserved = useMemo(
    () => effectiveCountryUnobserved(widget.countries,
      isFilter && widget.countries.kind === 'group' && groups.data
        ? groupUnobserved(groups.data, widget.countries.group)
        : effectiveMulti?.unobserved),
    [widget.countries, effectiveMulti?.unobserved, isFilter, groups.data],
  );

  const membership = useMemo<Readonly<Record<string, readonly (readonly [number, number])[]>> | null>(() => {
    if (!effectiveMulti?.membership) return null;
    const out: Record<string, [number, number][]> = {};
    for (const [tag, runs] of effectiveMulti.membership) {
      out[tag] = runs.map(run => [run.firstHour, run.lastHour]);
    }
    return out;
  }, [effectiveMulti?.membership]);

  const membershipRuns = useMemo(() => {
    if (!effectiveMulti?.membership) return null;
    return [...effectiveMulti.membership.values()].flat().map(run => ({
      tag: run.tag,
      firstHour: run.firstHour,
      lastHour: run.lastHour,
    }));
  }, [effectiveMulti?.membership]);

  const datedAtHour = isMulti && policy.datedAtHour === true;

  const cumulativeMembership = useMemo(
    () => (datedAtHour && fetchGroups ? cumulativeEverMembership(widget.countries, groups.data, lastHour) : null),
    [datedAtHour, fetchGroups, widget.countries, groups.data, lastHour],
  );

  const factionData = useMemo(
    () => extractFactionData(groups.data, isMulti && policy.factions === true),
    [isMulti, policy, groups.data],
  );

  const [laneDemands, setLaneDemands] = useState<readonly IdentityAsk[]>([]);
  const laneDemandsSigRef = useRef('');
  const onIdentityDemands = useCallback((demands: readonly (readonly [EntityKind, string, number])[]) => {
    const sig = demands.map(([k, key, h]) => `${k}\u0000${key}\u0000${h}`).join('\u0001');
    if (sig === laneDemandsSigRef.current) return;
    laneDemandsSigRef.current = sig;
    setLaneDemands(demands.map(([k, key, h]) => ({ key: parseEntityKey(k, key), hour: h })));
  }, []);

  const wantsIdentity = laneDemands.length > 0;
  useIdentities(runtime.client, track?.source, wantsIdentity ? identityScope : null, laneDemands, {
    active: active && wantsIdentity,
    needFlags: true,
    flagSize: 'panel',
    branchBounds,
  });
  const [providerOwner] = useState(() => ({}));
  const broker = identityBrokerFor(runtime.client);
  const identityProvider = useMemo<IdentityProvider | undefined>(() => {
    if (!identityScope) return undefined;
    return createBrokerIdentityProvider(broker, identityScope, providerOwner, {
      recording: track?.source,
      branchBounds,
      needFlags: true,
    });
  }, [broker, identityScope, providerOwner, track?.source, branchBounds]);
  useEffect(() => () => {
    if (identityScope) broker.setDemand(providerOwner, identityScope, null);
  }, [broker, identityScope, providerOwner]);

  const snapshots = useMemo(
    () => identitySnapshots(broker, identityScope, track?.source, branchBounds),
    [broker, identityScope, track?.source, branchBounds],
  );
  const identitySnapshot = useSyncExternalStore(snapshots.subscribe, snapshots.read, snapshots.read);

  const selectedSlots = useMemo(() => {
    if (!isFilter && !isMulti) return undefined;
    if (widget.countries.kind !== 'tags' && widget.countries.kind !== 'selected') return undefined;
    const identities = groups.data && validCountryIdentityHistories(groups.data.countryIdentities)
      ? countryIdentityIndex(groups.data.countryIdentities)
      : null;
    return resolveSelectedCountryRefs(widget.countries, selectedFallback, identities);
  }, [isFilter, isMulti, widget.countries, selectedFallback, groups.data]);

  const identityMembership = useMemo(
    () => (datedAtHour && fetchGroups ? datedIdentityMembership(widget.countries, groups.data, lastHour) : null),
    [datedAtHour, fetchGroups, widget.countries, groups.data, lastHour],
  );

  const countriesState = useMemo<DeclaredCountryState>(() => ({
    all: widget.countries.kind === 'all',
    tags: effectiveMulti?.tags ?? NO_TAGS,
    ...(selectedSlots !== undefined ? { selectedSlots } : {}),
    holders,
    every: allTags,
    top: effectiveMulti?.top ?? null,
    membership,
    cumulativeMembership,
    membershipRuns,
    identityMembership,
    unobserved,
    filter,
    factions: factionData.runs,
    factionUnobserved: factionData.unobserved,
    factionIncomplete: factionData.incomplete,
    rankedAt: (hour: number) => (effectiveMulti ? rankedCandidates(effectiveMulti, hour, effectiveMulti.tags) : NO_TAGS),
    reason: filterMatch?.reason ?? effectiveMulti?.reason ?? null,
    known: (first: number, last: number) => effectiveMulti?.known(first, last) ?? true,
    unobservedIn: (first: number, last: number) => overlapsHourRanges(unobserved, first, last),
  }), [widget.countries, effectiveMulti, selectedSlots, holders, allTags, membership, cumulativeMembership, membershipRuns, identityMembership, unobserved, filter, factionData, filterMatch?.reason]);

  const owner = useMemo(
    () => planOwner(kind, track, widget.time, widget.countries, isSingle ? countryTag : undefined),
    [kind, track, widget.time, isSingle, countryTag, widget.countries],
  );

  const rangeSpan = useMemo(
    () => (track ? plannedRangeSpan(widget.time.mode, track.branch, window) : null),
    [track, widget.time.mode, window],
  );

  const trackOffset = track?.axisOffset ?? 0;
  const [planCrossings, setPlanCrossings] = useState(0);
  const planHour = useMemo(
    () => (following ? Math.floor(runtime.clock.getHour()) + trackOffset : moment),
    [following, runtime.clock, trackOffset, moment, planCrossings, auxResult.data, countryTag, options],
  );

  const baseCtx = useMemo<Omit<FamilyPlanContext<TAux>, 'staticSpan'> | null>(() => {
    if (!track) return null;
    return {
      track,
      branch: track.branch,
      lastRecordedHour: lastRecorded,
      widget,
      options,
      following,
      aux: auxResult.data,
      countryTag,
      countrySubject,
      countryChoice,
      countryName,
      countries: countriesState,
      gateSpan: gate.span,
      planHour,
    };
  }, [track, lastRecorded, widget, options, following, auxResult.data, countryTag, countrySubject, countryChoice, countryName, countriesState, gate.span, planHour]);

  const gateStage = isSingle && !gate.open ? gate.stage : null;
  const planInputs: PlanInput[] = [];
  if (gateStage?.stage === 'failed') planInputs.push({ name: 'the country', state: 'failed', failure: gateStage.failure, retry: gateStage.retry });
  else if (gateStage?.stage === 'loading') planInputs.push({ name: 'the country', state: 'pending' });
  if (needsGroups) planInputs.push(isFilter && groups.data && !filterMatch?.ready ? { name: 'the country groups', state: 'pending' } : inputOf('the country groups', groups));
  if (needsSlots) planInputs.push(inputOf('the country holders', { data: slots, error: slotState.failure, retry: slotState.retry }));
  if (auxSpec && auxEnabled) planInputs.push(inputOf(auxSpec.label, auxResult, auxSpec.loadingLabel));
  const planReady = !!baseCtx && (!isSingle || gate.open) && allReady(planInputs)
    && !(isFilter && filterMatch?.reason) && !(isMulti && countriesState.reason);

  const planAtSize = useCallback((size: { width?: number; height?: number }) => {
    if (!baseCtx) return null;
    return planFamilySources(baseCtx, window, planReady, buildSources, {
      following,
      ...size,
    });
  }, [baseCtx, window, planReady, buildSources, following]);
  const planned = useMemo(() => planAtSize(measuredViewport.current), [planAtSize, viewportRevision]);
  const measureViewport = useCallback((width: number, height?: number) => {
    const prev = measuredViewport.current;
    const next = {
      width: stabilizeCanvasDimension(width, prev.width),
      height: stabilizeCanvasDimension(height, prev.height),
    };
    if (next.width === prev.width && next.height === prev.height) return;
    measuredViewport.current = next;
    if (planAtSize(next)?.sig !== planned?.sig) setViewportRevision(revision => revision + 1);
  }, [planAtSize, planned?.sig]);

  const ctx = planned?.ctx ?? null;
  const rawPlan = planned?.plan ?? null;

  const stablePlanRef = useRef<{ sig: string; plan: SourcePlan | null }>({ sig: '', plan: null });
  const sig = planned?.sig ?? plannedSignature(rawPlan, rangeSpan);
  if (sig !== stablePlanRef.current.sig) {
    stablePlanRef.current = { sig, plan: rawPlan };
  }
  const plan = stablePlanRef.current.plan;
  const planLo = rawPlan?.valid?.[0];
  const planHi = rawPlan?.valid?.[1];
  useEffect(() => {
    if (!following || !active || planLo === undefined || planHi === undefined) return;
    return watchPlanValid(runtime.clock, trackOffset, [planLo, planHi], () => {
      setPlanCrossings(value => value + 1);
    });
  }, [following, active, runtime.clock, trackOffset, planLo, planHi]);

  const compiledFollow = useMemo(() => {
    if (!following || !active || !plan) {
      return { subscriptions: [] as readonly CompiledFollowSubscription[], refused: null as string | null, unavailable: null as string | null, allowEmptyFollow: false };
    }
    return compileFollowPlan(plan, gate.checkFollow);
  }, [following, active, plan, gate.checkFollow]);

  const pixelBinnedKey = useMemo(() => {
    if (!plan) return '';
    const entries = plan.entries.filter(e => e.read.shape === 'pixel-binned');
    if (!entries.length) return '';
    return JSON.stringify(entries.map(e => {
      const r = e.read as Extract<typeof e.read, { shape: 'pixel-binned' }>;
      return [e.name, e.source.id, e.source.revision, e.branch, r.family, r.tags, r.keys ?? null, r.within ? [...r.within.entries()] : null, r.top ?? null, lastHour,
        ...(r.followRank === undefined ? [] : [r.followRank])];
    }));
  }, [plan, lastHour]);

  const tileViewsRef = useRef<Map<string, TileView>>(new Map());
  const tileViewsKeyRef = useRef('');
  const seriesViewportRef = useRef<TileViewport | null>(null);
  const strips = useContext(StripPageContext);
  const [stripTileConfig, setStripTileConfig] = useState('');
  const [tiledState, setTiledState] = useState<{
    readonly key: string;
    readonly series: Readonly<Record<string, ReadonlyMap<string, TiledLine>>>;
    readonly ready: boolean;
    readonly revision: number;
    readonly error: unknown;
    readonly topRefused?: string | null;
  }>({ key: '', series: {}, ready: false, revision: 0, error: null });

  const planForTilesRef = useRef(plan);
  planForTilesRef.current = plan;
  const hasFollowedRanks = plan?.entries.some(entry => entry.read.shape === 'pixel-binned' && entry.read.followRank !== undefined) === true;
  const gateSpanRef = useRef(gate.span);
  gateSpanRef.current = gate.span;
  const gateRecordedRef = useRef(gate.recorded);
  gateRecordedRef.current = gate.recorded;

  const applySeriesViewportRef = useRef<((vp: TileViewport) => void) | null>(null);
  const updateTileViewsRef = useRef<((update: (view: TileView) => void) => void) | null>(null);

  useEffect(() => {
    const currentPlan = planForTilesRef.current;
    if (!active || !pixelBinnedKey || !currentPlan) {
      applySeriesViewportRef.current = null;
      updateTileViewsRef.current = null;
      tileViewsKeyRef.current = '';
      for (const view of tileViewsRef.current.values()) view.close();
      tileViewsRef.current.clear();
      return;
    }
    const entries = currentPlan.entries.filter(
      (e): e is typeof e & { readonly read: Extract<typeof e.read, { shape: 'pixel-binned' }> } => e.read.shape === 'pixel-binned',
    );
    const views = new Map<string, TileView>();
    let disposed = false;
    let batching = false;
    let dirty = false;
    let rev = 0;
    let heldSeries = NO_TILED_SERIES;

    const publish = () => {
      if (disposed) return;
      if (batching) {
        dirty = true;
        return;
      }
      let firstError: unknown = null;
      let topRefused: string | null = null;
      let allReady = views.size > 0;
      for (const tv of views.values()) {
        if (!tv.settled) allReady = false;
        if (firstError === null && tv.error !== null) firstError = tv.error;
        if (!tv.usesFollowedRank) topRefused ??= tv.top?.refused ?? null;
      }
      if (!hasFollowedRanks && !allReady && firstError === null && topRefused === null) return;
      heldSeries = allReady || hasFollowedRanks ? reuseTiledSeries(heldSeries, views, allReady) : NO_TILED_SERIES;
      rev++;
      const snapshot = { key: pixelBinnedKey, series: heldSeries, ready: allReady, revision: rev, error: firstError, topRefused };
      inFrame(() => {
        if (!disposed) setTiledState(snapshot);
      });
    };

    for (const entry of entries) {
      const lane = chartTileLane(runtime.client, entry, lastHour, (first, last) => gateSpanRef.current(first, last),
        hour => gateRecordedRef.current(hour));
      if (lane) views.set(entry.name, new TileView(tileCache(runtime.client), lane, publish));
    }
    tileViewsRef.current = views;
    tileViewsKeyRef.current = pixelBinnedKey;
    const batchUpdates = (update: (view: TileView) => void) => {
      batching = true;
      dirty = false;
      try { views.forEach(update); } finally {
        batching = false;
        if (dirty) publish();
      }
    };
    updateTileViewsRef.current = batchUpdates;
    const applyViewport = (vp: TileViewport) => {
      batchUpdates(tv => tv.setView(vp));
      if (strips) setStripTileConfig(JSON.stringify([pixelBinnedKey, vp.width, vp.rolling, [...views.values()].map(view => view.stripBasis)]));
    };
    applySeriesViewportRef.current = applyViewport;
    if (seriesViewportRef.current) applyViewport(seriesViewportRef.current);
    return () => {
      disposed = true;
      if (applySeriesViewportRef.current === applyViewport) applySeriesViewportRef.current = null;
      if (updateTileViewsRef.current === batchUpdates) updateTileViewsRef.current = null;
      for (const tv of views.values()) tv.close();
      if (tileViewsRef.current === views) {
        tileViewsRef.current = new Map();
        tileViewsKeyRef.current = '';
      }
    };
  }, [runtime.client, active, pixelBinnedKey, lastHour, strips, hasFollowedRanks]);

  const onFollowedTileRanks = useCallback((hour: number, proof: readonly [number, number], ranks: TileRosters | undefined) => {
    if (!following || !runtime.clock.getSnapshot().playing || tileViewsKeyRef.current !== pixelBinnedKey) return;
    const recorded = gateRecordedRef.current(hour) !== null;
    updateTileViewsRef.current?.(tv => {
      if (tv.rankSource === undefined) return;
      tv.setHour(hour, true);
      const rank = recorded ? ranks?.[tv.rankSource] : undefined;
      tv.setFollowedRank(hour, rank ? { ...rank, hour, from: proof[0], until: proof[1] } : null);
    });
  }, [following, runtime.clock, pixelBinnedKey]);

  const onSeriesViewport = useCallback((nextViewport: TileViewport) => {
    seriesViewportRef.current = nextViewport;
    if (applySeriesViewportRef.current) applySeriesViewportRef.current(nextViewport);
    else for (const tv of tileViewsRef.current.values()) tv.setView(nextViewport);
  }, []);

  const retryTiles = useCallback(() => {
    for (const tv of tileViewsRef.current.values()) tv.retry();
  }, []);

  const hoverBrokerRef = useRef<FamilySourceBroker | null>(null);
  const [hover, setHover] = useState<{ hour: number; keys?: DrawnKeys; owner: string; sourceOwner?: string } | null>(null);
  const sourceOwner = plan?.owner;
  const onHoverHour = useCallback((hour: number | null, keys?: DrawnKeys) => {
    setHover(hour === null ? null : { hour, keys, owner, sourceOwner });
  }, [owner, sourceOwner]);
  const [heldHovers, setHeldHovers] = useState<Readonly<Record<string, HeldHover>>>({});
  const displayedSeries = tiledState.key === pixelBinnedKey ? tiledState.series : undefined;
  const asksRef = useRef<readonly HoverAsk[] | undefined>(undefined);
  const asks = useMemo(
    () => (asksRef.current = active && plan && hover?.owner === owner && hover.sourceOwner === sourceOwner
      ? hoverAsks(plan, hover.hour, name => displayedHoverKeys(name, hover.keys, displayedSeries), asksRef.current, hover.keys) : []),
    [active, plan, owner, sourceOwner, hover, displayedSeries],
  );
  const hovers = useMemo(() => currentHovers(asks, heldHovers), [asks, heldHovers]);
  const hoverSlotsRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!hoverBrokerRef.current) hoverBrokerRef.current = new FamilySourceBroker();
    const broker = hoverBrokerRef.current;
    const names = new Set(asks.map(ask => ask.name));
    for (const name of hoverSlotsRef.current) if (!names.has(name)) broker.cancelSlot(`hover:${name}`);
    hoverSlotsRef.current = names;
    setHeldHovers(prev => {
      const gone = Object.keys(prev).filter(name => !names.has(name));
      if (!gone.length) return prev;
      const kept = { ...prev };
      for (const name of gone) delete kept[name];
      return kept;
    });
    for (const ask of asks) {
      broker.runSlot(
        `hover:${ask.name}`,
        ask.key,
        async signal => {
          const reply = validateProductReply(await runtime.client.product(ask.request, signal), ask.request);
          return ask.validate ? ask.validate(reply.data) : reply.data;
        },
        data => {
          setHeldHovers(prev => ({ ...prev, [ask.name]: { key: ask.key, hour: ask.hour, data } }));
        },
      );
    }
  }, [asks, runtime.client]);

  useEffect(() => () => {
    hoverBrokerRef.current?.dispose();
    hoverBrokerRef.current = null;
  }, []);

  const pageBrokerRef = useRef<FamilySourceBroker | null>(null);
  const pagersRef = useRef<PagerSet>(emptyPagers(''));
  const [pagedRowsState, setPagedRowsState] = useState<{ readonly sig: string; readonly map: PagedRows }>({ sig: '', map: {} });
  const pagedPlanRef = useRef<{ plan: SourcePlan | null; sig: string; active: boolean }>({ plan, sig, active });
  pagedPlanRef.current = { plan, sig, active };

  const publishPagedRows = useCallback((forSig: string) => {
    const held = pagersRef.current;
    if (held.sig !== forSig) return;
    setPagedRowsState(prev => {
      const map: Record<string, PagedRows[string]> = {};
      let changed = prev.sig !== forSig;
      for (const [name, pager] of held.pagers) {
        map[name] = pager.pages();
        if (prev.map[name] !== map[name]) changed = true;
      }
      return changed ? { sig: forSig, map } : prev;
    });
  }, []);

  useEffect(() => {
    if (pagersRef.current.sig === sig) return;
    pageBrokerRef.current?.dispose();
    pageBrokerRef.current = null;
    pagersRef.current = replacePagers(pagersRef.current, sig, pagedEntries(pagedPlanRef.current.plan));
    setPagedRowsState({ sig, map: {} });
  }, [sig]);

  useEffect(() => () => {
    pageBrokerRef.current?.dispose();
    pageBrokerRef.current = null;
  }, []);

  const onRowWindow = useCallback((rowWindow: FamilyRowWindow, installedHour: number | null) => {
    const { plan: curPlan, sig: curSig, active: curActive } = pagedPlanRef.current;
    if (!curPlan || !curActive) return;
    const pagedEntries = curPlan.entries.filter(
      (entry): entry is SourceEntry & { readonly read: Extract<SourceEntry['read'], { shape: 'paged-rows' }> } => entry.read.shape === 'paged-rows',
    );
    if (!pagedEntries.length) return;
    if (pagersRef.current.sig !== curSig) {
      pageBrokerRef.current?.dispose();
      pageBrokerRef.current = null;
      pagersRef.current = replacePagers(pagersRef.current, curSig, pagedEntries);
    }
    if (!pageBrokerRef.current) pageBrokerRef.current = new FamilySourceBroker();
    const pageBroker = pageBrokerRef.current;
    const held = pagersRef.current;
    for (const entry of pagedEntries) {
      const { pager, step } = pagerWindow(held, entry, rowWindow, installedHour);
      for (const offset of step.cancel) pageBroker.cancelSlot(`page:${entry.name}:${offset}`);
      const validate = entry.read.validate ?? validateGenericTailReply;
      const owner = pager;
      for (const ask of step.fetch) {
        const req = buildTailPageRequest(entry, ask);
        if (!req) continue;
        pageBroker.runSlot(
          `page:${entry.name}:${ask.offset}`,
          `${curSig}|${entry.name}|${ask.hour}|${ask.offset}|${ask.limit}`,
          async signal => {
            const reply = validateProductReply(await runtime.client.product(req, signal), req);
            return { raw: reply.data, tail: validate(reply.data, ask.hour) };
          },
          ({ raw, tail }) => {
            if (pagersRef.current === held && owner.answer(ask, tail, raw)) publishPagedRows(curSig);
          },
          error => {
            if (pagersRef.current === held && owner.refuse(ask, asFailure(error).message)) publishPagedRows(curSig);
          },
        );
      }
    }
    publishPagedRows(curSig);
  }, [runtime.client, publishPagedRows]);

  const pagedRows = useMemo(
    () => (pagedRowsState.sig === sig && Object.keys(pagedRowsState.map).length ? pagedRowsState.map : undefined),
    [pagedRowsState, sig],
  );
  const pagedSnapshotRef = useRef<PagedSnapshot>(NO_PAGED_SNAPSHOT);
  const pagedSnapshot = useMemo(
    () => (pagedSnapshotRef.current = pagedSnapshots(pagedRows, pagedSnapshotRef.current)),
    [pagedRows],
  );

  const currentTiled = tiledState.key === pixelBinnedKey ? tiledState : null;

  const currentTiledSeries = currentTiled?.series;
  const [tileCrossings, setTileCrossings] = useState(0);
  const tileSeenHour = useMemo(
    () => Math.floor(runtime.clock.getHour()) + trackOffset,
    [currentTiledSeries, tileCrossings, runtime.clock, trackOffset],
  );
  const tileHour = following ? tileSeenHour : Math.floor(pinHour ?? window?.lastHour ?? effectiveEndHour);
  useEffect(() => {
    const tops = [...tileViewsRef.current.values()].filter(tv => tv.isTop);
    if (!active || !tops.length) return;
    const now = () => (following ? Math.floor(runtime.clock.getHour()) + trackOffset : tileHour);
    const apply = () => {
      const at = now();
      if (gateRecordedRef.current(at) === null) return;
      const playing = following && hasFollowedRanks && runtime.clock.getSnapshot().playing;
      updateTileViewsRef.current?.(tv => { if (tv.isTop) tv.setHour(at, playing); });
    };
    apply();
    if (!following) return;
    const proof = () => topTileProof(
      hasFollowedRanks && runtime.clock.getSnapshot().playing ? tops.filter(tv => tv.rankSource === undefined) : tops,
      now(),
      trackOffset,
      gateRecordedRef.current,
      at => (track ? coverageSpan(track, at) : [at, at]),
    );
    const stop = watchBoundary(runtime.clock, proof, apply);
    const stopMode = hasFollowedRanks ? runtime.clock.onPublish((previous, next) => {
      if (previous.playing !== next.playing || previous.seekSequence !== next.seekSequence) apply();
    }) : undefined;
    return () => { stop(); stopMode?.(); };
  }, [active, following, tileHour, pixelBinnedKey, currentTiled?.revision, runtime.clock, track, trackOffset, hasFollowedRanks]);
  const tileUnrecordedRef = useRef<HeldTileUnrecorded | null>(null);
  const completedTiledSeries = currentTiled?.ready ? currentTiledSeries : undefined;
  const tileUnrecorded = useMemo(() => {
    const held = reuseTileUnrecorded(tileUnrecordedRef.current, completedTiledSeries, tileHour);
    tileUnrecordedRef.current = held;
    return held?.result ?? null;
  }, [completedTiledSeries, tileHour]);
  const tileLo = tileUnrecorded?.validInterval[0];
  const tileHi = tileUnrecorded?.validInterval[1];
  useEffect(() => {
    if (!following || !active || tileLo === undefined || tileHi === undefined) return;
    const now = Math.floor(runtime.clock.getHour()) + trackOffset;
    if (now < tileLo || now > tileHi) {
      setTileCrossings(value => value + 1);
      return;
    }
    if (tileLo === -Infinity && tileHi === Infinity) return;
    return watchBoundary(
      runtime.clock,
      () => [tileLo - trackOffset, tileHi + 1 - trackOffset],
      () => { setTileCrossings(value => value + 1); },
    );
  }, [following, active, runtime.clock, trackOffset, tileLo, tileHi]);

  const entries = useMemo(
    () => unitEntries(plan, following, compiledFollow.subscriptions),
    [plan, following, compiledFollow.subscriptions],
  );
  const frozenGate = useMemo(
    () => freezeGate(gate, track ? (hour: number) => coverageSpan(track, hour) : undefined),
    [gate.open, track, countryTag, singleCountry?.aliases, singleCountry?.historyHeld],
  );
  const content = useContentRevision(runtime.client);
  const displayHour = pinHour ?? Math.floor(window?.lastHour ?? effectiveEndHour);
  const branch = track?.branch;
  const subscribed = following && compiledFollow.subscriptions.length > 0;

  const perfWidget = measuredWidget();
  const readInputs = useRef({ client: runtime.client, source: track?.source, content, perfWidget, clock: runtime.clock, trackOffset });
  readInputs.current = { client: runtime.client, source: track?.source, content, perfWidget, clock: runtime.clock, trackOffset };
  const targetRef = useRef<ReadTarget | null>(null);
  const readTarget = useCallback((): ReadTarget => targetRef.current ??= new ReadTarget(
    {
      now: () => Math.floor(readInputs.current.clock.getHour()) + readInputs.current.trackOffset,
      playing: () => readInputs.current.clock.getSnapshot().playing,
      seek: () => readInputs.current.clock.getSnapshot().seekSequence,
      subscribe: changed => readInputs.current.clock.subscribe(changed),
      watch: ([lo, hi], left) => {
        const { clock, trackOffset: offset } = readInputs.current;
        return watchBoundary(clock, () => [lo - offset, hi + 1 - offset], left);
      },
    },
    (unit, signal, restart) => {
      const { client, source, perfWidget: widgetId } = readInputs.current;
      countRead(widgetId, unit.spec!.request);
      return loadProduct(client, unit.spec!.request, signal, unit.spec!.validate, source, restart, undefined, undefined, true);
    },
    unit => {
      const { client, content: revision } = readInputs.current;
      return peekProduct(client, unit.spec!.request, productKey(unit.spec!.request, revision), unit.spec!.validate);
    },
  ), []);
  useEffect(() => () => {
    targetRef.current?.dispose();
    targetRef.current = null;
  }, []);
  const playback = useMemo(() => {
    if (!branch || !track) return null;
    const own = { branch, effectiveEndHour, gate: frozenGate, countriesKnown: countriesState.known };
    const others = new Map<string, typeof own | Omit<typeof own, 'countriesKnown'>>();
    return (entry: SourceEntry) => {
      if (entry.source.id === track.source.id && entry.branch === track.branch.id) return own;
      const key = JSON.stringify([entry.source.id, entry.branch]);
      let made = others.get(key);
      if (!made) {
        const other = runtime.tracks.find(item => item.source.id === entry.source.id && item.branch.id === entry.branch);
        made = other ? { branch: other.branch, effectiveEndHour: lastRecordedHour(other) ?? other.branch.lastHour, gate: trackGate(other) } : own;
        others.set(key, made);
      }
      return made;
    };
  }, [branch, track, effectiveEndHour, frozenGate, countriesState.known, runtime.tracks]);
  const pinned = useMemo(
    () => (branch ? { timeMode: widget.time.mode, branch, window, pinHour, gate: frozenGate, countriesKnown: countriesState.known } : null),
    [branch, widget.time.mode, window, pinHour, frozenGate, countriesState.known],
  );
  const inputs = useMemo(() => JSON.stringify([owner, following ? null : displayHour, sig, content]), [owner, following, displayHour, sig, content]);
  useLayoutEffect(() => {
    const common = { inputs, entries: branch ? entries : NO_ENTRIES, active, content, trackOffset };
    if (following && playback) readTarget().configure({ ...common, following: true, subscribed, playback });
    else if (!following && pinned) readTarget().configure({ ...common, following: false, displayHour, pinned, ...(playback ? { track: playback } : {}) });
    else readTarget().configure({ ...common, entries: NO_ENTRIES, following: false, displayHour, pinned: NO_PIN });
  }, [readTarget, inputs, branch, entries, active, content, trackOffset, following, subscribed, playback, pinned, displayHour]);
  const subscribeView = useCallback((changed: () => void) => readTarget().subscribe(() => inFrame(changed)), [readTarget]);
  const readView = useCallback(() => targetRef.current?.view() ?? NO_VIEW, []);
  const targetView = useSyncExternalStore(subscribeView, readView, readView);
  const view = shownView(targetView, inputs, !!branch && entries.length > 0);
  const retryUnits = useCallback(() => { targetRef.current?.retry(); }, []);
  const staticProof = useMemo<StaticProof>(() => ({
    read: () => targetRef.current?.proof() ?? null,
    subscribe: changed => readTarget().subscribeProof(changed),
  }), [readTarget]);

  const shownSpan = view.bundle?.span ?? rangeSpan;
  const spanStart = shownSpan ? shownSpan[0] : null;
  const spanEnd = shownSpan && !following ? shownSpan[1] : Infinity;
  const ctxWithStaticSpan = useMemo<FamilyPlanContext<TAux> | null>(() => {
    if (!ctx) return null;
    if (spanStart === null) return ctx;
    if (ctx.staticSpan && ctx.staticSpan[0] === spanStart && ctx.staticSpan[1] === spanEnd) return ctx;
    return { ...ctx, staticSpan: [spanStart, spanEnd] as const };
  }, [ctx, spanStart, spanEnd]);

  const currentExtra = useMemo<TExtra | undefined>(
    () => (ctxWithStaticSpan && captureExtra ? captureExtra(ctxWithStaticSpan) : undefined),
    [ctxWithStaticSpan, captureExtra],
  );

  interface FrozenView {
    readonly ctx: FamilyPlanContext<TAux> | null;
    readonly gate: FrozenGate;
    readonly plan: SourcePlan | null;
    readonly extra: TExtra | undefined;
  }

  const currentFrozen = useMemo<FrozenView>(
    () => ({ ctx: ctxWithStaticSpan, gate: frozenGate, plan, extra: currentExtra }),
    [ctxWithStaticSpan, frozenGate, plan, currentExtra],
  );

  const viewBundle = view.bundle;
  const viewPanels = viewBundle?.panels;
  const panelRecord = useMemo(() => (viewPanels ? Object.fromEntries(viewPanels) : null), [viewPanels]);
  const viewedBundle = useMemo<StaticBundle | null>(
    () => (viewBundle && panelRecord
      ? { stamp: viewBundle, hour: viewBundle.hour, span: viewBundle.span, proof: viewBundle.proof, ...(viewBundle.follows ? { follows: true } : {}), panels: panelRecord, ...(viewBundle.shifts ? { shifts: viewBundle.shifts } : {}) }
      : null),
    [viewBundle, panelRecord],
  );

  const shownRef = useRef<ShownBundle<StaticBundle, FrozenView> | null>(null);
  const shown = showBundle(shownRef.current, viewedBundle, view.held, sig, currentFrozen);
  shownRef.current = shown.last;
  const staticBundle = shown.shown?.bundle ?? null;
  const staticHeld = view.held && staticBundle !== null;
  const displayed = shown.shown?.frozen ?? currentFrozen;
  const displayedCtx = displayed.ctx;
  const displayedGate = displayed.gate;
  const displayedPlan = displayed.plan ?? plan;
  const displayedExtra = displayed.extra;

  const exactOptions = useMemo(() => displayedCtx ? {
      client: runtime.client,
      following,
      timeMode: widget.time.mode,
      branch: displayedCtx.branch,
      window,
      staticSpan: displayedCtx.staticSpan,
      gate: displayedGate,
  } : null, [displayedCtx, runtime.client, following, widget.time.mode, window, displayedGate]);

  const exactReadView = useMemo(() => {
    if (!exactOptions || !displayedPlan || !perfLog) return undefined;
    return createExactReadView(displayedPlan, pagedSnapshot, {
      ...exactOptions,
      exactOnce: (key, load) => perfLog!.exactOnce(key, load),
      identity: identityProvider,
      art: resolutions => createExactArtProvider({
        broker,
        scope: identityScope,
        recording: track?.source,
        ...(resolutions ? { resolutions } : {}),
      }),
    });
  }, [exactOptions, displayedPlan, pagedSnapshot, identityProvider, broker, identityScope, track?.source]);

  const viewport = measuredViewport.current;
  const frozenLog = (entry: SourceEntry) => entry.read.shape === 'paged-rows' && Object.values(pagedSnapshot[entry.name] ?? {}).some(page => page.kind === 'answered');
  const displayedEntries = strips && displayedPlan ? exactEntries(displayedPlan) : [];
  const fixedStrip = !following || (displayedEntries.length > 0 && displayedEntries.every(frozenLog));
  const hasStripChart = !!strips && !fixedStrip && !!displayedPlan?.entries.some(entry => entry.read.shape === 'pixel-binned');
  const terminalHour = strips && displayedCtx ? lastRecordedHour(displayedCtx.track) : null;
  const terminal = terminalHour === null ? null : displayedGate.recorded(terminalHour);
  const dayTiles = strips && !fixedStrip && exactOptions && terminal !== null
    ? holdDayTiles(displayedEntries, entry => buildExactRequests(entry, terminal, exactOptions)?.asks[0]?.request, content) : undefined;
  const stripKey = useMemo(() => {
    if (!strips || !displayedCtx || !displayedPlan) return '';
    const aliases = singleCountry?.aliases;
    const aux = displayedCtx.aux;
    return stripPlanKey(displayedPlan, sig, displayedCtx.options, stripProjection?.options(displayedCtx),
      fixedStrip, pagedSnapshot, content, viewport, stripProjection?.surface, options, stripTileConfig,
      aux && typeof aux === 'object' ? revisionOf(aux) : aux, revisionOf(displayedCtx.countries), aliases && revisionOf(aliases), displayedCtx.track.axisOffset,
      displayedCtx.branch.firstHour, displayedCtx.branch.lastHour, displayedCtx.branch.gaps);
  }, [strips, displayedCtx, displayedPlan, sig, stripProjection, fixedStrip, pagedSnapshot, content, viewport, options, singleCountry?.aliases, stripTileConfig]);
  const stripScope = strips && identityScope && displayedCtx?.track.source.id === identityScope.sourceId
    && displayedCtx.track.source.revision === identityScope.revision && displayedCtx.branch.id === identityScope.branchId ? identityScope : null;
  const stripPlan: UseFamilyPlanResult<TAux, TExtra>['stripPlan'] = strips && exactOptions && displayedCtx && displayedPlan ? {
    key: stripKey,
    fixed: fixedStrip,
    ...(stripScope ? { identity: { scope: stripScope, recording: displayedCtx.track.source, bounds: branchBounds } } : {}),
    track: { branch: { firstHour: displayedCtx.branch.firstHour, lastHour: displayedCtx.branch.lastHour, gaps: displayedCtx.branch.gaps },
      axisOffset: displayedCtx.track.axisOffset },
    supported: fixedStrip || stripScope !== null,
    tilesSettled: () => !hasStripChart || (tileViewsKeyRef.current === pixelBinnedKey && !!seriesViewportRef.current
      && [...tileViewsRef.current.values()].every(view => view.settled || view.error !== null)),
    ...((hasStripChart || dayTiles?.size) ? { tiles: async (claim, read) => {
      if (dayTiles?.size) await dayTiles.prepare(claim, read);
      if (!hasStripChart) return;
      const vp = seriesViewportRef.current!;
      const hours = strips.lattice.hours(16).flatMap(axis => displayedGate.recorded(axis + trackOffset) ?? []);
      if (!hours.length) return;
      for (const chart of tileViewsRef.current.values()) {
        if (chart.error !== null) throw chart.error;
        await chart.holdStrip(displayedCtx.branch.firstHour, hours, claim, read, vp.rolling);
      }
    } } : {}),
    keyframe: axis => {
      if (fixedStrip) return { asks: [] };
      const recorded = displayedGate.recorded(axis + trackOffset);
      if (recorded === null) {
        const coverage = coverageAt(displayedCtx.track, axis + trackOffset);
        return { asks: [], scene: coverage.hour === null ? { outside: coverage.outside }
          : { recorded: coverage.hour, parts: [], allowEmpty: false } };
      }
      const alias = singleCountry ? singleCountry.aliasAt(recorded) : displayedCtx.countryTag;
      const nameRead = alias ? heldCountryNameAt(runtime.client, displayedCtx.track, content, recorded, alias) : undefined;
      const name = nameRead?.kind === 'value' || nameRead?.kind === 'absent' || alias !== displayedCtx.countryTag ? nameReadText(nameRead) : displayedCtx.countryName;
      const ctx = stripContextAt(displayedCtx, displayedPlan.valid, recorded, alias, name);
      const plan = ctx === displayedCtx ? displayedPlan : buildSources(ctx, { following, ...viewport, staticSpan: ctx.staticSpan });
      return buildStripKeyframe(plan, recorded, { ...exactOptions, pagedSnapshot: name => pagedSnapshot[name] ?? null },
        ctx === displayedCtx ? undefined : stripProjection?.options(ctx),
        (entry, request) => frozenLog(entry) ? null : dayTiles ? dayTiles.slot(entry, request) : entry.name);
    },
  } : undefined;

  const loadingLabel = plan?.loadingLabel ?? `Loading ${subject}…`;
  const hasStaticBundle = staticBundle !== null;
  const allowEmpty = following
    ? compiledFollow.allowEmptyFollow
    : (plan?.allowEmptyFollow === true && !plan.refused && !plan.unavailable);

  const history = (isMulti || isFilter) && policy.content === 'history';
  const spanCover = useMemo(() => (history ? groupSpanCover(widget.countries, groups.data) : null), [history, widget.countries, groups.data]);
  const spanFirst = rangeSpan?.[0] ?? firstHour;
  const spanClock = useMemo(() => {
    const at = () => (following ? Math.floor(runtime.clock.getHour()) + trackOffset : moment);
    return {
      subscribe: (changed: () => void) => (spanCover && following && active
        ? watchBoundary(runtime.clock, axis => {
            const state = groupSpanStateAt(spanCover, spanFirst, Math.floor(axis) + trackOffset);
            return [state.from - trackOffset, state.until + 1 - trackOffset];
          }, changed)
        : () => {}),
      read: () => (spanCover ? groupSpanStateAt(spanCover, spanFirst, at()).kind : null),
    };
  }, [spanCover, spanFirst, following, active, runtime.clock, trackOffset, moment]);
  const spanKind = useSyncExternalStore(spanClock.subscribe, spanClock.read, spanClock.read);
  const spanBody = useMemo(
    () => groupSpanBodyStatus(spanKind, spanCover, widget.countries, spanFirst > firstHour),
    [spanKind, spanCover, widget.countries, spanFirst, firstHour],
  );

  const everDates = useMemo(() => ((isMulti || isFilter) && !history ? everBounds(widget.countries, groups.data) : null), [isMulti, isFilter, history, widget.countries, groups.data]);
  const everClock = useMemo(() => {
    const at = () => (following ? Math.floor(runtime.clock.getHour()) + trackOffset : moment);
    return {
      subscribe: (changed: () => void) => (everDates && following && active
        ? watchBoundary(runtime.clock, axis => {
            const state = everStateAt(everDates, Math.floor(axis) + trackOffset);
            return [state.from - trackOffset, state.until + 1 - trackOffset];
          }, changed)
        : () => {}),
      read: () => (everDates ? everStateAt(everDates, at()).kind : null),
    };
  }, [everDates, following, active, runtime.clock, trackOffset, moment]);
  const everKind = useSyncExternalStore(everClock.subscribe, everClock.read, everClock.read);
  const everBody = useMemo<FamilyBodyStatus | null>(
    () => (everKind === 'empty' ? { kind: 'no-members', reason: NO_MEMBERS.yet } : everKind === 'unrecorded' ? { kind: 'not-recorded', reason: EVER_UNRECORDED } : null),
    [everKind],
  );

  const datedIncomplete = useMemo(
    () => (datedAtHour && widget.countries.kind === 'group' && widget.countries.membership === 'hour' && groups.data && effectiveMulti && !effectiveMulti.tags.length && unobserved.length > 0 ? unobserved : null),
    [datedAtHour, widget.countries, groups.data, effectiveMulti, unobserved],
  );
  const incompleteClock = useMemo(() => {
    const at = () => (following ? Math.floor(runtime.clock.getHour()) + trackOffset : moment);
    return {
      subscribe: (changed: () => void) => (datedIncomplete && following && active
        ? watchBoundary(runtime.clock, axis => {
            const state = incompleteHourStateAt(datedIncomplete, Math.floor(axis) + trackOffset);
            return [state.from - trackOffset, state.until + 1 - trackOffset];
          }, changed)
        : () => {}),
      read: () => (datedIncomplete ? incompleteHourStateAt(datedIncomplete, at()).kind : null),
    };
  }, [datedIncomplete, following, active, runtime.clock, trackOffset, moment]);
  const incompleteKind = useSyncExternalStore(incompleteClock.subscribe, incompleteClock.read, incompleteClock.read);
  const incompleteBody = useMemo<FamilyBodyStatus | null>(
    () => incompleteGroupBodyStatus(incompleteKind, following),
    [incompleteKind, following],
  );

  const atTime = pinHour !== null || !!window;
  const tilesWait = !following && atTime && (!currentTiled || (!Object.keys(currentTiled.series).length && !currentTiled.topRefused));
  const unitsWait = !hasStaticBundle && view.kind !== 'outside' && view.kind !== 'none' && (following || !pixelBinnedKey || atTime);
  const tileInputs: PlanInput[] = [];
  if (pixelBinnedKey && currentTiled?.error) tileInputs.push({ name: 'the chart history', state: 'failed', failure: asFailure(currentTiled.error), retry: retryTiles });
  else if (pixelBinnedKey && tilesWait) tileInputs.push({ name: 'the chart history', state: 'pending' });
  const unitInputs: PlanInput[] = [];
  if (view.failure) unitInputs.push({ name: subject, state: 'failed', failure: view.failure.failure, retry: retryUnits });
  else if (unitsWait) unitInputs.push({ name: subject, state: 'pending', loadingLabel: plan?.loadingLabel });

  const early = ((): FamilyBodyStatus | null => {
    if (!track) return { kind: 'unbound', message: emptyCampaign };
    if (gateStage) {
      const s = gateStage;
      if (s.stage === 'outside') return { kind: 'outside', outside: s.outside };
      if (s.stage === 'choose') return { kind: 'choose', message: (policy.mode === 'single' ? policy.choose : undefined) ?? `Choose a country to see its ${subject}.` };
      if (s.stage === 'holders') return { kind: 'holders', tag: singleCountry?.chosen ?? null, holders: s.holders, pick: s.pick };
      if (s.stage === 'absent') {
        const msg = nameFailureDetail ? 'This country does not exist at this date.' : `${countryName} does not exist at this date.`;
        return { kind: 'absent', message: s.reason ?? msg, detail: nameFailureDetail };
      }
    } else if (!isSingle && coverage.outside) {
      return {
        kind: 'outside',
        outside: {
          kind: coverage.outsideKind,
          message: coverage.outsideMessage ?? (coverage.outsideKind === 'not-recorded' ? 'Not recorded at this time.' : 'This time is outside the recording.'),
          detail: coverage.outsideDetail,
          span: coverage.outsideSpan,
          pinned: coverage.outsidePinned,
        },
      };
    }

    return !plan?.refused && compiledFollow.refused ? { kind: 'refused', reason: compiledFollow.refused, technical: compiledFollow.refused } : null;
  })();
  const tileReason = pixelBinnedKey ? currentTiled?.topRefused || tileUnrecorded?.reason : null;
  const tileOutcome = tileReason ? { kind: 'not-recorded' as const, reason: tileReason } : null;
  const outcome = ((): FamilyBodyStatus | null => {
    if (history && spanBody) return spanBody;
    if (isFilter) {
      if (filterMatch?.reason) return { kind: 'refused', reason: filterMatch.reason };
      if (countriesState.reason) return { kind: 'refused', reason: countriesState.reason };
      if (everBody) return everBody;
    }

    if (isMulti && history) {
      if (countriesState.reason) return { kind: 'empty', message: countriesState.reason };
    } else if (isMulti) {
      if (incompleteBody) return incompleteBody;
      if (countriesState.reason) return { kind: 'empty', message: countriesState.reason };
      if (everBody) return everBody;
      if (effectiveMulti && !following) {
        if (datedAtHour) {
          const staticStatus = staticDatedGroupBodyStatus(widget.countries, effectiveMulti, groups.data, membership, moment, countriesState.rankedAt(moment));
          if (staticStatus) return staticStatus;
        } else {
          const none = noMembersAt(widget.countries, effectiveMulti, groups.data, moment);
          if (none) return { kind: 'no-members', reason: none.reason };
          if (effectiveMulti.top == null && !countriesState.rankedAt(moment).length && !policy.allowSingleSlot) {
            const why = groups.data && widget.countries.kind === 'group' ? worldFilter(widget.countries, [], groups.data, moment).reason : null;
            return { kind: 'refused', reason: why ?? (widget.countries.kind === 'group' ? NO_MEMBERS.date : 'No countries available for this selection.') };
          }
        }
      }
    }

    if (tileOutcome) return tileOutcome;
    const refusal = plan?.refused ?? (following ? compiledFollow.unavailable : null);
    return refusal ? { kind: 'refused', reason: refusal } : null;
  })();
  const settled = ((): FamilyBodyStatus => {
    if (following) return view.kind === 'outside' ? { kind: 'outside' } : { kind: 'ready' };
    if (pixelBinnedKey) return atTime ? { kind: 'ready' } : { kind: 'outside' };
    if (view.kind === 'none') return allowEmpty ? { kind: 'ready' } : pinHour === null ? { kind: 'outside' } : { kind: 'loading', label: loadingLabel };
    return view.kind === 'outside' ? { kind: 'outside' } : { kind: 'ready' };
  })();
  const bodyStatus = familyBodyStatus({ early, plan: planInputs, outcome, tiles: tileInputs, units: unitInputs, settled });

  const bannerFailure: BannerFailureInfo | null = (isSingle && singleCountry?.chosen && singleCountry.error && singleCountry.historyHeld)
    ? { failure: singleCountry.error, retry: singleCountry.retry }
    : ((isFilter || needsGroups) && groups.error && groups.data)
      ? { failure: groups.error, retry: groups.retry }
      : null;

  const bounds = useMemo<readonly [number, number] | null>(
    () => (track ? [track.branch.firstHour, track.branch.lastHour] : null),
    [track?.branch.firstHour, track?.branch.lastHour],
  );

  const pin = following ? null : (staticBundle?.hour ?? pinHour ?? (pixelBinnedKey || allowEmpty ? window?.lastHour ?? null : null));

  return {
    track,
    options,
    following,
    owner,
    ctx: ctxWithStaticSpan,
    displayedCtx,
    recorded: gate.recorded,
    countryHolder: isSingle ? singleCountry?.holder ?? null : null,
    displayedExtra,
    plan: displayedPlan,
    subscriptions: compiledFollow.subscriptions,
    allowEmptyFollow: allowEmpty,
    followRefused: compiledFollow.refused,
    staticBundle,
    staticProof,
    staticHeld,
    pagedRows,
    onRowWindow,
    tiledSeries: currentTiled?.series ?? NO_SERIES,
    ...(hasFollowedRanks ? { onFollowedTileRanks } : {}),
    onSeriesViewport,
    retryTiles,
    onHoverHour,
    hovers,
    exactReadView,
    stripPlan,
    bodyStatus,
    keepFollowingWhenBlocked: following && tileOutcome !== null && bodyStatus === tileOutcome && compiledFollow.subscriptions.length > 0,
    bannerFailure,
    nameFailureDetail,
    groupWarnings: groups.data?.warnings ?? [],
    moment,
    bounds,
    pin,
    offset: track?.axisOffset ?? 0,
    loadingLabel,
    identitySnapshot,
    identityProvider,
    onIdentityDemands,
    measureViewport,
  };
}
