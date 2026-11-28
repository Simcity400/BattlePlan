import { SECONDARY_DASH, tailColour } from '../../charts/palette.ts';
import { countryFromKey } from '../../dashboard/countryKey.ts';
import { compareTags } from '../../dashboard/tagOrder.ts';
import type { OptionValue } from '../../dashboard/options';
import { FutureDataError, type AuxProductSpec, type BoundedReadView, type BoundedSeries, type FamilyPlanContext, type SourceEntry, type SourcePlan } from '../contract.ts';
import type { HolderRun, HourRanges } from '../holders.ts';
import { formatCompactRational, formatRational, formatRecordedPercent, formatScalar } from '../valueFormat.ts';
import { timeChartCacheState } from './cacheControl.ts';
import { type TimeChartProjection, type TimeChartWidgetDeclaration } from './declaration.ts';
import { registerFamilyProjection } from '../registry.ts';
import { auditRow } from '../auditRow.ts';
import { formatChartAxisValue } from './layout.ts';
import { chartAxis, chartWindow, DEFAULT_LINE_SETTINGS, lineChartSettings, type LineChartSettings } from './settings.ts';
import type { ChartGap, ChartHoverDetail, ChartLegendEntry, ChartValueFormat, TimeChartModel, TimeChartSeriesModel } from './model.ts';
import { seriesLookAt } from './model.ts';
import {
  branchGapsOf,
  chartTopOf,
  countrySeriesLooks,
  auditReading,
  exactHoverByCountry,
  headReading,
  headValueOf,
  memberAt,
  missingSpansOf,
  rankEntry,
  rankedCountries,
  rankedOrder, unnamedLooks,
  withinMapOf,
  type ExactReading,
  type KnownHeadReading,
} from './seriesHelpers.ts';

export interface CountryLinesMeasure {
  readonly kind: string;
  readonly measure: string;
  readonly decimals: number;
}

export interface CountryLinesUnavailable {
  readonly unavailable: string;
}

const measureOf = (chosen: CountryLinesMeasure | CountryLinesUnavailable | null): CountryLinesMeasure | null =>
  chosen && 'measure' in chosen ? chosen : null;

export interface CountryLinesSecond {
  readonly measure: string;
  readonly legend: readonly [string, string];
}

export interface CountryLine {
  readonly tag: string;
  readonly name: string;
  readonly color: string;
  readonly exact?: ExactReading | null;
}

export interface CountryLinesOptions {
  readonly tags: readonly string[];
  readonly top: ReturnType<typeof chartTopOf>;
  readonly holders?: Readonly<Record<string, readonly HolderRun[]>> | null;
  readonly membership?: Readonly<Record<string, HourRanges>> | null;
  readonly decimals: number;
  readonly unavailable: string | null;
  readonly digits: number | null;
  readonly endLabels: boolean;
  readonly second: CountryLinesSecond | null;
  readonly options: Readonly<Record<string, OptionValue>>;
  readonly extent: readonly [number, number];
  readonly gaps: readonly ChartGap[];
  readonly surface: string;
  readonly settings?: LineChartSettings;
}

export interface CountryLinesHover {
  readonly entry: (ctx: FamilyPlanContext) => SourceEntry;
  readonly detail: (readView: BoundedReadView, lines: readonly CountryLine[], options: CountryLinesOptions) => ChartHoverDetail | null;
}

export interface CountryLinesSpec<TAux = unknown> {
  readonly kind: string;
  readonly view: string;
  readonly title: string;
  readonly subject: string;
  readonly format: Extract<ChartValueFormat, 'compact' | 'number' | 'percent'>;
  readonly step?: boolean;
  readonly slotBackedRank?: boolean;
  readonly aux?: AuxProductSpec<TAux>;
  readonly measure: (options: Readonly<Record<string, OptionValue>>, aux: TAux | undefined) => CountryLinesMeasure | CountryLinesUnavailable | null;
  readonly second?: (options: Readonly<Record<string, OptionValue>>) => CountryLinesSecond | null;
  readonly digits?: (options: Readonly<Record<string, OptionValue>>) => number;
  readonly hover?: CountryLinesHover;
}


function hoverHourOf(readView: BoundedReadView, name: string): number | null {
  try {
    return readView.hover(name)?.hour ?? null;
  } catch (error) {
    if (error instanceof FutureDataError) return null;
    throw error;
  }
}
const COLOURED = 8;

function tileReadingAt(line: BoundedSeries, hour: number): KnownHeadReading | null {
  for (const spans of [line.missing, line.partial, line.approximate]) {
    const span = spans?.at(spans.length - 1);
    if (span && span.firstHour <= hour && hour <= span.lastHour) return null;
  }
  const run = line.runs?.at(line.runs.length - 1);
  if (run?.lastHour === hour) return { value: run.value };
  const bucket = line.buckets.at(line.buckets.length - 1);
  return bucket?.lastHour === hour ? { value: bucket.lastValue } : null;
}

const SECOND_SUFFIX = '\u0000second';

export function formatCountryValue(value: number, format: CountryLinesSpec['format'], digits: number | null = null): string {
  if (format === 'compact') return formatChartAxisValue(value, 'compact');
  if (format === 'percent') {
    return digits === null
      ? formatRecordedPercent(value)
      : formatScalar(value, { decimals: 0, maxDecimals: digits, fixedDecimals: true, percent: true });
  }
  return formatScalar(value, { decimals: 0, maxDecimals: digits ?? 2 });
}

const COUNTRY_READING_CACHE_MAX = 512;
const countryReadingCache = new Map<string, string>();

function formatCountryReading(reading: KnownHeadReading, format: CountryLinesSpec['format'], digits: number | null = null): string {
  const useCache = timeChartCacheState.enabled;
  const key = useCache
    ? (reading.raw !== undefined && reading.denominator !== undefined
      ? `${format}|${digits ?? ''}|r|${reading.raw}|${reading.denominator}`
      : `${format}|${digits ?? ''}|v|${reading.value}`)
    : '';
  if (useCache) {
    const cached = countryReadingCache.get(key);
    if (cached !== undefined) return cached;
  }
  let text: string;
  if (reading.raw !== undefined && reading.denominator !== undefined) {
    if (format === 'compact') text = formatCompactRational(reading.raw, reading.denominator, { maxDecimals: 0 }).text;
    else if (format === 'percent') {
      text = formatRational(reading.raw, reading.denominator, { maxDecimals: digits ?? 5, fixedDecimals: digits !== null, percent: true });
    } else {
      text = formatRational(reading.raw, reading.denominator, { maxDecimals: digits ?? 2 });
    }
  } else {
    text = formatCountryValue(reading.value, format, digits);
  }
  if (useCache) {
    if (countryReadingCache.size >= COUNTRY_READING_CACHE_MAX) countryReadingCache.clear();
    countryReadingCache.set(key, text);
  }
  return text;
}

export function buildCountryLinesView<TAux = unknown>(spec: CountryLinesSpec<TAux>): {
  readonly projection: TimeChartProjection<CountryLinesOptions>;
  readonly declaration: TimeChartWidgetDeclaration<CountryLinesOptions, TAux>;
} {
  const followRank = spec.slotBackedRank ? {} : { followRank: 'main' };
  const projection: TimeChartProjection<CountryLinesOptions> = {
    kind: spec.kind,
    family: 'time-chart',
    variant: 'line',
    joinMode: spec.step ? 'step' : 'join',
    measureTitle: spec.title,
    project(readView: BoundedReadView, options: CountryLinesOptions): TimeChartModel {
      const hour = readView.hour;
      if (options.unavailable !== null) {
        return {
          kind: spec.kind,
          measureTitle: spec.title,
          mode: 'lines',
          hour,
          extent: options.extent,
          yAxis: { format: spec.format },
          series: [],
          empty: { message: options.unavailable, kind: 'unavailable' },
          auditRows: [],
        };
      }
      const top = options.top !== null;
      const answered = top ? readView.answer('main') : undefined;
      if (top) {
        const ranked = answered ? undefined : readView.panel<{ readonly refused?: string | null }>('main');
        const refused = readView.refused('main')
          ?? (answered?.kind === 'notRecorded' ? answered.reason : undefined)
          ?? ranked?.refused
          ?? undefined;
        if (refused) {
          return {
            kind: spec.kind,
            measureTitle: spec.title,
            mode: 'lines',
            hour,
            extent: options.extent,
            yAxis: { format: spec.format },
            series: [],
            empty: { message: refused, kind: 'unavailable' },
            auditRows: [auditRow('__rank__', refused)],
            ...(!spec.slotBackedRank ? { followedTileRanks: { main: { tags: [], refused } } } : {}),
          };
        }
      }
      const settings = options.settings ?? DEFAULT_LINE_SETTINGS;
      const view = chartWindow(settings, hour, options.extent[0]);
      const drawn = readView.series('main');
      const population = top ? rankedCountries(readView, 'main') : null;
      const followedTileRanks = !spec.slotBackedRank && answered && population
        ? { main: { tags: [...population.rows.keys()].sort(), refused: null } }
        : undefined;
      const tileHeads = top && !population && drawn
        ? new Map([...drawn].map(([tag, line]) => [tag, tileReadingAt(line, hour)]))
        : null;
      const tags = tileHeads
        ? [...tileHeads].sort(([a, left], [b, right]) => {
            if (left && right) return right.value - left.value || compareTags(a, b);
            return left ? -1 : right ? 1 : 0;
          }).map(([tag]) => tag)
        : top ? [...(population?.rows.keys() ?? [])] : options.tags;
      if (top && (drawn !== undefined || population !== null) && tags.length === 0) {
        return {
          kind: spec.kind,
          measureTitle: spec.title,
          mode: 'lines',
          hour,
          extent: options.extent,
          ...(view ? { view } : {}),
          yAxis: { format: spec.format, decimals: options.digits ?? options.decimals, exactDecimals: options.decimals, ...chartAxis(settings) },
          series: [],
          empty: { message: `No ${spec.subject} recorded at this date.`, kind: 'empty' },
          auditRows: [],
          ...(followedTileRanks ? { followedTileRanks } : {}),
        };
      }
      const present = tags.filter(tag => memberAt(options.membership, tag, hour));
      const presentSet = new Set(present);
      const ranking = rankedOrder(readView, present);
      const ordered = [...ranking.order, ...tags.filter(tag => !presentSet.has(tag))];
      const colouredCount = tileHeads
        ? ordered.slice(0, COLOURED).filter(tag => presentSet.has(tag) && tileHeads.get(tag)).length
        : COLOURED;
      const looks = unnamedLooks(countrySeriesLooks(ordered, readView, {
        holders: options.holders,
        from: options.extent[0],
        surface: options.surface,
        withFlag: true,
        colouredCount,
        tailColor: tailColour(options.surface),
      }), population?.unnamed ?? ranking.unnamed, hour, population?.tags);
      const exactByCountry = exactHoverByCountry(readView, 'hover', options.decimals);
      const secondLines = options.second ? readView.series('second') : undefined;
      const detailHour = spec.hover ? hoverHourOf(readView, 'detail') : null;
      const lines: CountryLine[] = [];
      const auditRows: ReturnType<typeof auditReading>[] = [];
      const format = (reading: KnownHeadReading) => formatCountryReading(reading, spec.format, options.digits);
      const recorded = (reading: KnownHeadReading) => formatCountryReading(reading, spec.format === 'percent' ? 'percent' : 'number', spec.format === 'percent' ? null : options.decimals);
      const series: TimeChartSeriesModel[] = [];
      const hasHover = spec.hover !== undefined;
      for (let rank = 0; rank < ordered.length; rank++) {
        const tag = ordered[rank]!;
        const isTail = rank >= colouredCount;
        const bounded = drawn?.get(tag) ?? null;
        const headKey = { tag, rankRow: population?.rows.get(tag) };
        const reading = presentSet.has(tag) ? headReading(readView, 'main', headKey, options.decimals) ?? tileHeads?.get(tag) ?? null : undefined;
        if (reading !== undefined) auditRows.push(auditReading(tag, reading, recorded));
        const headValue = headValueOf(reading);
        const exact = exactByCountry?.get(tag) ?? null;
        const look = looks.get(tag)!;
        const { name, flag, color, identities } = look;
        if (hasHover && (detailHour === null || memberAt(options.membership, tag, detailHour))) {
          const atDetail = detailHour === null ? look : seriesLookAt(look, detailHour);
          lines.push({
            tag,
            name: atDetail.name,
            color: atDetail.color,
            exact: exact && (detailHour === null || exact.hour === detailHour) ? exact : null,
          });
        }
        series.push({
          id: tag,
          key: tag,
          name,
          color,
          role: isTail ? 'tail' : 'primary',
          step: spec.step === true,
          bounded,
          headValue,
          headHour: hour,
          exact: exact && memberAt(options.membership, tag, exact.hour) ? exact : null,
          flag,
          identities,
          missingSpans: missingSpansOf(bounded),
          endLabel: isTail || !reading || !('value' in reading) || !options.endLabels
            ? null
            : { flag, name, fullName: name, value: format(reading) },
        });
        if (!options.second) continue;
        const secondBounded = secondLines?.get(tag) ?? null;
        const secondReading = presentSet.has(tag)
          ? headReading(readView, 'second', { tag }, options.decimals) ?? (top ? headReading(readView, 'main', { ...headKey, reading: 1 }, options.decimals) : null)
          : undefined;
        if (secondReading !== undefined) auditRows.push(auditReading(`${tag}${SECOND_SUFFIX}`, secondReading, recorded));
        series.push({
          id: `${tag}${SECOND_SUFFIX}`,
          key: `${tag}${SECOND_SUFFIX}`,
          name: `${name} · ${options.second.legend[1]}`,
          color,
          identities: identities.map(run => ({ ...run, name: `${run.name} · ${options.second!.legend[1]}` })),
          role: isTail ? 'tail' : 'secondary',
          step: spec.step === true,
          dash: SECONDARY_DASH,
          bounded: secondBounded,
          headValue: headValueOf(secondReading),
          headHour: hour,
          missingSpans: missingSpansOf(secondBounded),
          endLabel: null,
        });
      }
      const legend: ChartLegendEntry[] | undefined = options.second
        ? [{ id: 'main', label: options.second.legend[0] }, { id: 'second', label: options.second.legend[1], dash: SECONDARY_DASH }]
        : undefined;
      return {
        kind: spec.kind,
        measureTitle: spec.title,
        mode: 'lines',
        hour,
        extent: options.extent,
        ...(view ? { view } : {}),
        yAxis: { format: spec.format, decimals: options.digits ?? options.decimals, exactDecimals: options.decimals, ...chartAxis(settings) },
        series,
        drawnKeys: options.second ? { main: ordered, second: ordered } : { main: ordered },
        ...(followedTileRanks ? { followedTileRanks } : {}),
        ...(legend ? { legend } : {}),
        gaps: options.gaps.length > 0 ? options.gaps : undefined,
        ...(ranking.warnings.length > 0 ? { warnings: ranking.warnings } : {}),
        hoverDetail: spec.hover ? spec.hover.detail(readView, lines, options) : undefined,
        auditRows,
      };
    },
  };

  const declaration: TimeChartWidgetDeclaration<CountryLinesOptions, TAux> = {
    family: 'time-chart',
    kind: spec.kind,
    label: spec.title,
    subject: spec.subject,
    emptyCampaign: `Load a campaign to see ${spec.subject}.`,
    icon: 'chart-line',
    countries: { mode: 'multi', content: 'history', allowSlots: true },
    ...(spec.aux ? { aux: spec.aux } : {}),
    sources(ctx: FamilyPlanContext<TAux>): SourcePlan {
      const top = chartTopOf(ctx.countries);
      const tags = top === null ? ctx.countries.tags : [];
      const measure = measureOf(spec.measure(ctx.options, ctx.aux));
      const second = spec.second?.(ctx.options) ?? null;
      const owner = `${spec.kind}:${spec.view}:${ctx.track.source.id}:${ctx.branch.id}:${top === null ? tags.join(',') : `top${top}`}:${measure?.measure ?? ''}:${second?.measure ?? ''}`;
      if (!measure || (top === null && tags.length === 0)) return { owner, entries: [] };
      const family = { kind: measure.kind, measure: measure.measure };
      const secondFamily = second ? { kind: measure.kind, measure: second.measure } : null;
      const common = { source: ctx.track.source, branch: ctx.branch.id, offset: ctx.track.axisOffset };
      const detailEntry = (rankedMode: boolean): SourceEntry[] => {
        if (!spec.hover) return [];
        const base = { ...spec.hover.entry(ctx), name: 'detail' };
        if (base.read.shape !== 'exact-hover') return [base];
        const read = base.read;
        if (rankedMode) {
          return [{
            ...base,
            read: read.readsOf !== undefined ? read : { ...read, countriesOf: read.countriesOf ?? 'main' },
          }];
        }
        return [{
          ...base,
          read: {
            ...read,
            ...(read.params && read.readsOf === undefined ? { params: { ...read.params, countries: tags.map(countryFromKey) } } : {}),
            ...(ctx.countries.membership ? { membership: ctx.countries.membership } : {}),
          },
        }];
      };
      if (top !== null) {
        const params = { branchId: ctx.branch.id, family, ...(top === 'all' ? {} : { top }) };
        const ranked: SourceEntry[] = [
          {
            name: 'main',
            ...common,
            read: {
              shape: 'pixel-binned',
              coverage: top === 'all' ? { mode: 'population', form: 'all' } : { mode: 'population', form: 'top', limit: top },
              family,
              tags: [],
              top: { n: top },
              ...followRank,
              headQuery: { product: 'series-state', params },
              params: second ? { ...params, measures: [second.measure] } : params,
              exactProduct: 'series-rank',
            },
          },
          ...(secondFamily
            ? [{
                name: 'second',
                ...common,
                read: {
                  shape: 'pixel-binned' as const,
                  coverage: top === 'all' ? { mode: 'population' as const, form: 'all' as const } : { mode: 'population' as const, form: 'top' as const, limit: top },
                  family: secondFamily,
                  tags: [],
                  top: { n: top, by: measure.measure },
                  ...followRank,
                },
              }]
            : []),
          { name: 'hover', ...common, read: { shape: 'exact-hover', product: 'series-state', params: { branchId: ctx.branch.id, family }, readsOf: 'main' } },
          ...detailEntry(true),
        ];
        return { owner, entries: ranked };
      }
      const within = withinMapOf(ctx.countries.membership);
      const reads = tags.map(tag => ({ country: countryFromKey(tag) }));
      const entries: SourceEntry[] = [
        {
          name: 'main',
          ...common,
          read: {
            shape: 'pixel-binned',
            coverage: { mode: 'keyed', keys: tags },
            family,
            tags,
            ...(within ? { within } : {}),
            headQuery: { product: 'series-state', coverage: 'row', params: { branchId: ctx.branch.id, family, reads } },
            exactProduct: 'series-state',
          },
        },
        ...(secondFamily
          ? [{
              name: 'second',
              ...common,
              read: {
                shape: 'pixel-binned' as const,
                coverage: { mode: 'keyed' as const, keys: tags },
                family: secondFamily,
                tags,
                ...(within ? { within } : {}),
                headQuery: { product: 'series-state' as const, coverage: 'row' as const, params: { branchId: ctx.branch.id, family: secondFamily, reads } },
                exactProduct: 'series-state' as const,
              },
            }]
          : []),
        {
          name: 'hover',
          ...common,
          read: {
            shape: 'exact-hover',
            product: 'series-state',
            params: { branchId: ctx.branch.id, family, reads },
            ...(ctx.countries.membership ? { membership: ctx.countries.membership } : {}),
          },
        },
        ...detailEntry(false),
      ];
      const rank = rankEntry(ctx, family, tags);
      if (rank) entries.push(rank);
      return { owner, entries };
    },
    projection,
    unavailable(ctx) {
      const chosen = spec.measure(ctx.options, ctx.aux);
      return chosen && 'unavailable' in chosen ? chosen.unavailable : null;
    },
    projectionOptions(ctx, { extent, surface }) {
      return {
        tags: chartTopOf(ctx.countries) === null ? ctx.countries.tags : [],
        top: chartTopOf(ctx.countries),
        holders: ctx.countries.holders,
        membership: chartTopOf(ctx.countries) === null ? ctx.countries.membership : null,
        decimals: measureOf(spec.measure(ctx.options, ctx.aux))?.decimals ?? 0,
        unavailable: (() => {
          const chosen = spec.measure(ctx.options, ctx.aux);
          return chosen && 'unavailable' in chosen ? chosen.unavailable : null;
        })(),
        digits: spec.digits?.(ctx.options) ?? null,
        endLabels: ctx.options.endLabels !== false,
        second: spec.second?.(ctx.options) ?? null,
        options: ctx.options,
        extent,
        gaps: branchGapsOf(ctx.branch),
        surface,
        settings: lineChartSettings(ctx.options, ctx.following),
      };
    },
  };
  return { projection, declaration };
}

export function createCountryLinesView<TAux = unknown>(spec: CountryLinesSpec<TAux>): {
  readonly projection: TimeChartProjection<CountryLinesOptions>;
  readonly declaration: TimeChartWidgetDeclaration<CountryLinesOptions, TAux>;
} {
  const built = buildCountryLinesView(spec);
  const projection = registerFamilyProjection(built.projection, spec.view);
  return { projection, declaration: { ...built.declaration, projection } };
}
