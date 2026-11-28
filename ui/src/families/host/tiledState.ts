import { validateProductReply, type DashboardClient, type ProductRequest } from '../../dashboard/client.ts';
import { countryFromKey } from '../../dashboard/countryKey.ts';
import { keyId, keyedTileParams, keyedTileReply, type SeriesKey } from '../../dashboard/keyedSeriesData.ts';
import { prepareGate, preparing } from '../../dashboard/prepare.ts';
import type { BoundWindow, GatedHour } from '../../dashboard/regionTime.ts';
import { productRequest } from '../../dashboard/request.ts';
import type { StripTileRead } from '../../dashboard/tiles/cache.ts';
import type { TileReply } from '../../dashboard/tiles/tile.ts';
import type { HourSpan } from '../../generated/dashboard.ts';
import type { PixelBinnedSourceRead, SourceEntry } from '../plan.ts';
import type { TileLane, TiledLine, TileView } from '../../dashboard/tiles/view.ts';
import { boundedUnrecorded, type UnrecordedLine } from '../boundedView.ts';

export function chartTileLane(
  client: DashboardClient, entry: SourceEntry & { read: PixelBinnedSourceRead }, lastHour: number,
  gateSpan: (first: number, last: number) => BoundWindow | null, recorded: (hour: number) => GatedHour | null,
): TileLane | null {
  const prepared = preparing(client);
  const read = entry.read;
  const keyed = read.keys && read.keys.length > 0 ? read.keys : null;
  const population = read.coverage.mode === 'population' && read.coverage.form === 'all' && !read.tags.length;
  if (!keyed && !read.tags.length && !read.top && !population) return null;
  const byId = keyed ? new Map<string, SeriesKey>(keyed.map(key => [keyId(key), key])) : null;
  const laneTags = keyed ? keyed.map(keyId) : read.tags;
  const tileRequest = (binHours: number, index: number, tags: readonly string[], within: Record<string, HourSpan[]> | undefined): ProductRequest =>
    productRequest({
      sourceId: entry.source.id,
      revision: entry.source.revision,
      product: 'series-tiles',
      params: keyed && byId
        ? {
            branchId: entry.branch,
            family: read.family,
            binHours,
            index,
            ...keyedTileParams(tags.map(id => byId.get(id)!), within, gateSpan),
          }
        : {
            branchId: entry.branch,
            family: read.family,
            binHours,
            index,
            countries: tags.map(countryFromKey),
            ...(within
              ? { within: tags.map(tag => [countryFromKey(tag), (within[tag] ?? []).flatMap(span => gateSpan(span.firstHour, span.lastHour) ?? [])] as const) }
              : {}),
          },
    });
  const ask = async (binHours: number, index: number, tags: readonly string[], within: Record<string, HourSpan[]> | undefined, send?: StripTileRead) => {
    const request = tileRequest(binHours, index, tags, within);
    const reply = send ? (await send<TileReply>(request)).data
      : validateProductReply(await client.product<TileReply>(request, new AbortController().signal), request).data;
    return keyed && byId ? keyedTileReply(reply as Parameters<typeof keyedTileReply>[0], tags.map(id => byId.get(id)!)) : reply;
  };
  const promote = prepared ? (...asked: Parameters<typeof tileRequest>) => prepareGate(client).promote(tileRequest(...asked)) : undefined;
  const laneKey = `${entry.source.id}|${entry.source.revision}|${entry.branch}|${JSON.stringify(read.family)}${keyed ? '|keyed' : ''}`;
  const readTop = read.top;
  const top = readTop || population
    ? {
        ask: async (binHours: number, index: number, hour: number, send?: StripTileRead) => {
          const gated = recorded(hour);
          if (gated === null) throw new Error('The displayed hour is outside the recording.');
          const request = productRequest({
            sourceId: entry.source.id,
            revision: entry.source.revision,
            product: 'series-tiles',
            params: { branchId: entry.branch, family: read.family, binHours, index, ...(readTop ? { ...(readTop.n === 'all' ? {} : { top: readTop.n }), ...(readTop.least ? { least: true } : {}), ...(readTop.by ? { rankBy: readTop.by } : {}) } : {}), hour: gated },
          });
          return send ? (await send<TileReply>(request)).data
            : validateProductReply(await client.product<TileReply>(request, new AbortController().signal), request).data;
        },
      }
    : undefined;
  return { key: laneKey, tags: laneTags, within: read.within, lastHour, ask, prepared, promote,
    ...(top ? { top, ...(read.followRank === undefined ? {} : { followRank: read.followRank }) } : {}) };
}

export type TiledSeriesMap = Readonly<Record<string, ReadonlyMap<string, TiledLine>>>;

export const NO_TILED_SERIES: TiledSeriesMap = Object.freeze({});

export function reuseTiledSeries(
  previous: TiledSeriesMap,
  views: ReadonlyMap<string, Pick<TileView, 'current' | 'rankSource' | 'top' | 'usesFollowedRank'>>,
  ready = true,
): TiledSeriesMap {
  if (!ready) {
    let next: Record<string, ReadonlyMap<string, TiledLine>> | undefined;
    for (const [name, held] of Object.entries(previous)) {
      const view = views.get(name);
      if (view?.rankSource === undefined) continue;
      const rank = view.usesFollowedRank ? view.top : null;
      if (!rank) {
        next ??= { ...previous };
        delete next[name];
        continue;
      }
      const tags = new Set(rank.tags);
      if ([...held.keys()].every(tag => tags.has(tag))) continue;
      next ??= { ...previous };
      next[name] = new Map([...held].filter(([tag]) => tags.has(tag)));
    }
    return next ? (Object.keys(next).length ? next : NO_TILED_SERIES) : previous;
  }
  let count = 0;
  let same = true;
  for (const [name, tv] of views) {
    if (!tv.current) continue;
    count++;
    if (previous[name] !== tv.current) same = false;
  }
  if (same && count === Object.keys(previous).length) return previous;
  if (count === 0) return Object.keys(previous).length === 0 ? previous : NO_TILED_SERIES;
  const next: Record<string, ReadonlyMap<string, TiledLine>> = {};
  for (const [name, tv] of views) if (tv.current) next[name] = tv.current;
  return next;
}

export interface HeldTileUnrecorded {
  readonly series: TiledSeriesMap;
  readonly result: ReturnType<typeof boundedUnrecorded> | null;
}

export function reuseTileUnrecorded(
  previous: HeldTileUnrecorded | null,
  series: TiledSeriesMap | undefined,
  hour: number,
): HeldTileUnrecorded | null {
  if (!series) return null;
  if (
    previous
    && previous.series === series
    && (previous.result === null || (hour >= previous.result.validInterval[0] && hour <= previous.result.validInterval[1]))
  ) {
    return previous;
  }
  const lines: UnrecordedLine[] = [];
  for (const entry of Object.values(series)) for (const line of entry.values()) lines.push(line);
  return { series, result: lines.length ? boundedUnrecorded(lines, hour) : null };
}

export function topTileProof(
  tops: readonly Pick<TileView, 'top'>[],
  at: number,
  trackOffset: number,
  gateRecorded: (hour: number) => number | null,
  unrecordedSpan: (hour: number) => readonly [number, number],
): readonly [number, number] {
  if (gateRecorded(at) === null) {
    const [unrecordedLo, unrecordedHi] = unrecordedSpan(at);
    return [unrecordedLo - trackOffset, unrecordedHi + 1 - trackOffset];
  }
  let lo = -Infinity;
  let hi = Infinity;
  for (const tv of tops) {
    const held = tv.top;
    lo = Math.max(lo, held ? held.from : at);
    hi = Math.min(hi, held ? held.until : at);
  }
  return [lo - trackOffset, hi + 1 - trackOffset];
}
