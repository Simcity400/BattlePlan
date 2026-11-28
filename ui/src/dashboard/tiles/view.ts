import type { ChartBucket, ChartSummary } from '../../charts/chartSummary';
import type { MarkCluster, MarkSummary } from '../../charts/markSummary';
import type { Run } from '../../charts/series';
import type { HourSpan, MissingSpan, TilePart } from '../../generated/dashboard';
import { TileCache } from './cache.ts';
import type { StripTileClaim, StripTileRead } from './cache.ts';
import { countryKey } from '../countryKey.ts';
import { tileHead, valueAtHead } from './head.ts';
import { FIRST_BREAK, HAS_BREAK, LEVEL, PRESENT, RUN, SEAM, TILE_BINS, TILE_GROUP, binHoursOf, tileLast, tilesOf } from './tile.ts';
import type { Tile, TileReply } from './tile.ts';

export interface TileViewport {
  from: number; to: number; end: number; width: number;
  rolling?: { first: number; hours: number };
}

export const AHEAD_BINS = 32;

export const HELD_BINS_PER_PIXEL = 4;

export function viewBinHours(hours: number, width: number, held?: { binHours: number; width: number }): number {
  const ideal = binHoursOf(hours, width);
  return held && held.width === width && ideal > held.binHours && hours <= HELD_BINS_PER_PIXEL * width * held.binHours ? held.binHours : ideal;
}

export interface TileLane {
  key: string;
  tags: readonly string[];
  within?: ReadonlyMap<string, readonly HourSpan[]>;
  lastHour: number;
  marks?: boolean;
  ask(binHours: number, index: number, tags: readonly string[], within: Record<string, HourSpan[]> | undefined, read?: StripTileRead): Promise<TileReply>;
  prepared?: boolean;
  promote?(binHours: number, index: number, tags: readonly string[], within: Record<string, HourSpan[]> | undefined): void;
  top?: TileTop;
  followRank?: string;
}

export interface TileTop {
  ask(binHours: number, index: number, hour: number, read?: StripTileRead): Promise<TileReply>;
}

export interface TileRoster {
  readonly tags: readonly string[];
  readonly refused: string | null;
}

export type TileRosters = Readonly<Record<string, TileRoster>>;
export const TILE_ROSTER_FIELD = 'model:tile-rank';

export interface TileRanked extends TileRoster {
  readonly hour: number;
  readonly from: number;
  readonly until: number;
}

export interface TiledLine { tag: string; head: string; decimals: number; summary: ChartSummary; missing: MissingSpan[]; partial?: MissingSpan[]; parts: TilePart[]; marks: MarkSummary | null }

interface Wanted { binHours: number; first: number; last: number; width: number; cell: number; keys: string[] }
interface Assembled { binHours: number; first: number; last: number; width: number; cell: number }

export const CLUSTER_PIXELS = 18;

export function cellBins(hours: number, width: number, binHours: number, held?: number): number {
  const exact = CLUSTER_PIXELS * hours / (Math.max(1, width) * binHours);
  if (held !== undefined && Math.abs(exact - held) < 0.75) return held;
  return Math.max(1, Math.round(exact));
}

function spansFor(within: TileLane['within'], tag: string, binHours: number, index: number): HourSpan[] | undefined {
  if (!within) return undefined;
  const from = index * TILE_BINS * binHours - binHours, to = (index + 1) * TILE_BINS * binHours - 1;
  return (within.get(tag) ?? []).flatMap(span => span.lastHour < from || span.firstHour > to ? []
    : [{ firstHour: Math.max(from, span.firstHour), lastHour: Math.min(to, span.lastHour) }]);
}

const fresh = (tile: Tile & { askedFor?: number }, lastHour: number) => tile.immutable
  || (tile.askedFor ?? -Infinity) >= lastHour
  || (tile.filled === null ? tile.firstHour > lastHour : tile.filled >= Math.min(tileLast(tile), lastHour));

let nextRankStrip = 0;

function rankAt(ranks: readonly TileRanked[], hour: number): TileRanked | null {
  let first = 0, end = ranks.length;
  while (first < end) {
    const mid = (first + end) >>> 1;
    if (ranks[mid]!.until < hour) first = mid + 1;
    else end = mid;
  }
  const rank = ranks[first];
  return rank && rank.from <= hour ? rank : null;
}

export class TileView {
  private wanted: Wanted | null = null;
  private lines: ReadonlyMap<string, TiledLine> | null = null;
  private told: { readonly failure: unknown; readonly refused: string | null; readonly from: number | null; readonly until: number | null } = { failure: null, refused: null, from: null, until: null };
  private readonly made = new WeakMap<TiledLine, { readonly tiles: readonly Tile[]; readonly from: number; readonly to: number; readonly width: number; readonly cell: number | null }>();
  private assembled: Assembled | null = null;
  private failure: unknown = null;
  private closed = false;
  private ranked: TileRanked | null = null;
  private followingRank = false;
  private rankHour: number | null = null;
  private rankAsked = 0;
  private rankPending = false;
  private rankFailedHour: number | null = null;
  private readonly cache: TileCache;
  private readonly lane: TileLane;
  private readonly cacheLane: ReturnType<TileCache['acquireLane']>;
  private readonly changed: () => void;
  asked = 0;

  constructor(cache: TileCache, lane: TileLane, changed: () => void) {
    this.cache = cache; this.lane = lane; this.changed = changed;
    this.cacheLane = cache.acquireLane(lane.key);
  }

  private tileKey(tag: string, binHours: number, index: number): string {
    const spans = spansFor(this.lane.within, tag, binHours, index);
    return `${this.cacheLane.id}${this.lane.marks ? '|marks' : ''}|${binHours}|${index}|${tag}${spans ? `|${JSON.stringify(spans)}` : ''}`;
  }

  get current(): ReadonlyMap<string, TiledLine> | null { return this.assembled ? this.lines : null; }
  get settled(): boolean {
    return this.lines !== null && this.wanted !== null && this.assembled !== null
      && this.assembled.binHours === this.wanted.binHours
      && this.assembled.first <= this.wanted.first
      && this.wanted.last <= this.assembled.last
      && this.assembled.width === this.wanted.width
      && this.assembled.cell === this.wanted.cell;
  }
  get error(): unknown { return this.failure; }
  get top(): TileRanked | null { return this.ranked; }
  get isTop(): boolean { return !!this.lane.top; }
  get rankSource(): string | undefined { return this.lane.followRank; }
  get usesFollowedRank(): boolean { return this.followingRank; }
  get stripBasis(): number | null { return this.wanted?.binHours ?? null; }

  async holdStrip(firstHour: number, hours: readonly number[], claim: StripTileClaim, read: StripTileRead, rolling?: TileViewport['rolling']) {
    const basis = this.wanted;
    if (!basis || this.closed) throw new Error('The chart has no settled tile width');
    const { binHours, width } = basis;
    if (rolling && [hours[0], hours.at(-1)].some(hour => hour !== undefined
      && viewBinHours(Math.max(1, Math.min(rolling.hours, hour - rolling.first) + 1), width, basis) !== binHours)) {
      throw new Error('A rolling chart changes tile width across the timeline');
    }
    const { lane } = this, tags = new Set(lane.tags);
    const span = TILE_BINS * binHours, first = Math.floor(firstHour / span), last = Math.floor(lane.lastHour / span);
    const keep = (key: string) => {
      const tile = this.cache.get(key);
      return !!tile && fresh(tile, lane.lastHour) && claim.keep(key);
    };
    const save = (reply: TileReply, index: number, keys: readonly string[]) => {
      if (this.closed) throw new Error('The chart tile view changed');
      for (const tile of tilesOf(reply, keys, binHours, index, tag => this.tileKey(tag, binHours, index))) {
        if (!keep(tile.key)) claim.put(Object.assign(tile, { askedFor: lane.lastHour }), this.cacheLane);
      }
    };
    const rankKey = `${lane.key}|strip-rank|${++nextRankStrip}`;
    if (lane.top) {
      const ranks: TileRanked[] = [];
      for (const hour of hours) {
        if (hour <= (ranks.at(-1)?.until ?? -Infinity)) continue;
        const index = Math.floor(hour / span);
        const reply = await lane.top.ask(binHours, index, hour, read);
        const rank = reply.ranking;
        if (!rank || !(rank.from <= hour && hour <= rank.until)) throw new Error('The chart tile reply names no top for this hour');
        const ranked = reply.lines.map(line => countryKey(line.country));
        save(reply, index, ranked);
        ranked.forEach(tag => tags.add(tag));
        ranks.push({ ...rank, tags: ranked });
      }
      claim.put({ key: rankKey, value: ranks, bytes: new TextEncoder().encode(JSON.stringify(ranks)).byteLength });
    }
    for (let index = first; index <= last; index++) {
      const lacking = [...tags].filter(tag => !keep(this.tileKey(tag, binHours, index)));
      for (let at = 0; at < lacking.length; at += TILE_GROUP) {
        const group = lacking.slice(at, at + TILE_GROUP);
        save(await lane.ask(binHours, index, group, this.withinFor(group, binHours, index), read), index, group);
      }
    }
    return (view: TileViewport, hour: number) => {
      if (!claim.active) throw new Error('The chart tile claim was released');
      const desired = this.desired(view, this.wanted);
      const assembled = this.assembled, ranked = this.ranked;
      const sameRank = !lane.top || (ranked && ranked.from <= hour && hour <= ranked.until);
      const wanted = sameRank && assembled && assembled.binHours === desired.binHours && assembled.width === desired.width
        && assembled.cell === desired.cell && assembled.first <= desired.first && desired.last <= assembled.last ? assembled : desired;
      if (wanted.binHours !== binHours || wanted.width !== width) throw new Error('The chart tile width changed');
      const rank = rankAt(claim.value<TileRanked[]>(rankKey) ?? [], hour);
      const lines = new Map<string, TiledLine>();
      for (const tag of lane.top ? rank?.tags ?? [] : lane.tags) {
        const tiles: Tile[] = [];
        for (let index = wanted.first; index <= wanted.last; index++) {
          const tile = this.cache.get(this.tileKey(tag, binHours, index));
          if (!tile) throw new Error('The chart is missing a held tile');
          tiles.push(tile);
        }
        lines.set(tag, line(tag, tileHead(lane.key, tag), tiles, wanted.first * span, (wanted.last + 1) * span - 1, width, lane.marks ? wanted.cell : null));
      }
      return { lines, rank };
    };
  }

  private get tags(): readonly string[] {
    return this.lane.top ? this.ranked?.tags ?? [] : this.lane.tags;
  }

  setHour(hour: number, playing = false): void {
    if (this.closed || !this.lane.top) return;
    const follow = playing && this.rankSource !== undefined;
    if (follow !== this.followingRank) {
      this.followingRank = follow;
      this.rankAsked++;
      this.rankPending = false;
      if (this.rankFailedHour !== null) this.failure = null;
      this.rankFailedHour = null;
      if (!follow || !this.ranked || hour < this.ranked.from || hour > this.ranked.until) this.setRank(null);
      else if (this.failure !== this.told.failure) this.notify();
    }
    this.rankHour = hour;
    if (follow) return;
    const held = this.ranked;
    if (held && hour >= held.from && hour <= held.until) return;
    if (this.rankPending || this.rankFailedHour === hour) return;
    this.askTop();
  }

  setFollowedRank(hour: number, rank: TileRanked | null): void {
    if (!this.closed && this.followingRank) {
      this.setRank(rank && rank.from <= hour && hour <= rank.until ? rank : null);
    }
  }

  private setRank(rank: TileRanked | null): void {
    const before = this.ranked;
    if (!before && !rank) {
      if (this.failure !== this.told.failure) this.notify();
      return;
    }
    this.ranked = rank;
    if (before && rank && before.refused === rank.refused
      && (before.tags === rank.tags || (before.tags.length === rank.tags.length && before.tags.every((tag, at) => tag === rank.tags[at])))) return;
    this.repin();
    this.fetch();
    this.assemble();
    if (!rank || !this.settled || this.lines?.size !== rank.tags.length
      || [...(this.lines?.keys() ?? [])].some((tag, at) => tag !== rank.tags[at])) {
      this.assembled = null;
      this.notify();
    }
  }

  private askTop(): void {
    const top = this.lane.top, wanted = this.wanted, hour = this.rankHour;
    if (this.followingRank || !top || !wanted || hour === null) return;
    const binHours = wanted.binHours, index = Math.max(wanted.first, Math.min(wanted.last, Math.floor(hour / (TILE_BINS * binHours))));
    const asked = ++this.rankAsked;
    this.rankPending = true;
    this.rankFailedHour = null;
    this.asked++;
    void top.ask(binHours, index, hour).then(reply => {
      if (this.closed || asked !== this.rankAsked) return;
      this.rankPending = false;
      this.rankFailedHour = null;
      this.failure = null;
      const ranking = reply.ranking;
      if (!ranking || !Array.isArray(reply.lines)) throw new Error('The chart tile reply names no top.');
      const tags = reply.lines.map(held => countryKey(held.country));
      const tiles = tilesOf(reply, tags, binHours, index, tag => this.tileKey(tag, binHours, index));
      for (const tile of tiles) {
        const held = this.cache.has(tile.key) ? this.cache.get(tile.key) : undefined;
        if (!held || !fresh(held, this.lane.lastHour)) this.cache.put(Object.assign(tile, { askedFor: this.lane.lastHour }), this.cacheLane);
      }
      this.ranked = { tags, hour: ranking.hour, from: ranking.from, until: ranking.until, refused: ranking.refused };
      this.repin();
      this.fetch();
      this.assemble();
      const now = this.rankHour;
      if (now !== null && (now < ranking.from || now > ranking.until)) this.askTop();
    }).catch(error => {
      if (this.closed || asked !== this.rankAsked) return;
      this.rankPending = false;
      this.rankFailedHour = hour;
      this.failure = error;
      this.notify();
    });
  }

  private repin(): void {
    const wanted = this.wanted;
    if (!wanted) return;
    const keys: string[] = [];
    for (let index = wanted.first; index <= wanted.last; index++) for (const tag of this.tags) keys.push(this.tileKey(tag, wanted.binHours, index));
    this.cache.pin(keys);
    this.cache.unpin(wanted.keys);
    wanted.keys = keys;
  }

  private desired(view: TileViewport, before: Wanted | null): Assembled {
    const binHours = viewBinHours(view.end - view.from + 1, view.width, before ?? undefined), span = TILE_BINS * binHours;
    const cell = cellBins(view.end - view.from + 1, view.width, binHours, before?.binHours === binHours && before.width === view.width ? before.cell : undefined);
    const first = Math.floor(view.from / span);
    const ahead = Math.min(this.lane.lastHour, view.to + AHEAD_BINS * binHours);
    const last = Math.max(first, Math.floor(Math.max(view.to, ahead) / span));
    return { binHours, first, last, width: view.width, cell };
  }

  setView(view: TileViewport): void {
    if (this.closed || view.to < view.from) return;
    const next = this.desired(view, this.wanted);
    const { binHours, first, last, width, cell } = next;
    const held = this.wanted;
    if (held && held.binHours === binHours && held.first === first && held.last === last && held.width === width && held.cell === cell) return;
    const keys: string[] = [];
    for (let index = first; index <= last; index++) for (const tag of this.tags) keys.push(this.tileKey(tag, binHours, index));
    this.cache.pin(keys);
    if (held) this.cache.unpin(held.keys);
    this.wanted = { ...next, keys };
    if (this.lane.top && !this.ranked && !this.rankPending && this.rankHour !== null && this.rankFailedHour !== this.rankHour) this.askTop();
    this.fetch();
    const made = this.assembled;
    if (made && made.binHours === binHours && made.width === width && made.cell === cell && made.first <= first && last <= made.last) return;
    this.assemble();
  }

  retry(): void {
    this.failure = null;
    this.rankFailedHour = null;
    if (this.lane.top && !this.ranked && !this.rankPending && this.rankHour !== null) this.askTop();
    this.fetch();
    this.assemble();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.wanted) this.cache.unpin(this.wanted.keys);
    this.cache.releaseLane(this.cacheLane);
  }

  private fetch(): void {
    const wanted = this.wanted;
    if (!wanted) return;
    for (let index = wanted.first; index <= wanted.last; index++) {
      const lacking: string[] = [], waiting = new Set<Promise<void>>();
      for (const tag of this.tags) {
        const key = this.tileKey(tag, wanted.binHours, index);
        const tile = this.cache.get(key);
        if (tile && fresh(tile, this.lane.lastHour)) continue;
        const flight = this.cache.inflight.get(key);
        if (!flight) { lacking.push(tag); continue; }
        waiting.add(flight);
        if (!this.lane.prepared) this.cache.joins.get(key)?.();
      }
      for (const flight of waiting) void flight.then(() => this.assemble(), () => {});
      for (let at = 0; at < lacking.length; at += TILE_GROUP) this.request(wanted.binHours, index, lacking.slice(at, at + TILE_GROUP));
    }
  }

  private request(binHours: number, index: number, tags: string[]): void {
    const lane = this.lane, lastHour = lane.lastHour;
    const keys = tags.map(tag => this.tileKey(tag, binHours, index));
    const within = this.withinFor(tags, binHours, index);
    this.asked++;
    const flight = lane.ask(binHours, index, tags, within).then(reply => {
      const tiles = tilesOf(reply, tags, binHours, index, tag => keys[tags.indexOf(tag)]);
      for (const tile of tiles) this.cache.put(Object.assign(tile, { askedFor: lastHour }), this.cacheLane);
    });
    this.cache.retainLane(this.cacheLane);
    const join = lane.promote && (() => lane.promote!(binHours, index, tags, within));
    for (const key of keys) {
      this.cache.inflight.set(key, flight);
      if (join) this.cache.joins.set(key, join); else this.cache.joins.delete(key);
    }
    void flight.then(() => this.assemble(), error => {
      if (this.closed) return;
      this.failure = error;
      this.notify();
    }).finally(() => {
      for (const key of keys) if (this.cache.inflight.get(key) === flight) { this.cache.inflight.delete(key); this.cache.joins.delete(key); }
      this.cache.releaseLane(this.cacheLane);
    });
  }

  private withinFor(tags: readonly string[], binHours: number, index: number): Record<string, HourSpan[]> | undefined {
    const within = this.lane.within;
    return within && Object.fromEntries(tags.map(tag => [tag, spansFor(within, tag, binHours, index)!]));
  }

  private assemble(): void {
    const wanted = this.wanted;
    if (this.closed || !wanted) return;
    if (this.lane.top && !this.ranked) return;
    const wasSettled = this.settled;
    const tiles: Tile[][] = [];
    for (const tag of this.tags) {
      const own: Tile[] = [];
      for (let index = wanted.first; index <= wanted.last; index++) {
        const tile = this.cache.get(this.tileKey(tag, wanted.binHours, index));
        if (!tile) return;
        own.push(tile);
      }
      tiles.push(own);
    }
    const span = TILE_BINS * wanted.binHours, from = wanted.first * span, to = (wanted.last + 1) * span - 1, cell = this.lane.marks === true ? wanted.cell : null;
    const previous = this.lines ? [...this.lines.keys()] : [];
    const lines = new Map<string, TiledLine>();
    let same = this.lines !== null && previous.length === this.tags.length;
    this.tags.forEach((tag, at) => {
      const held = this.lines?.get(tag);
      const made = held ? this.made.get(held) : undefined;
      const kept = made && made.from === from && made.to === to && made.width === wanted.width && made.cell === cell
        && made.tiles.length === tiles[at].length && made.tiles.every((tile, index) => tile === tiles[at][index]) ? held! : null;
      if (!kept || previous[at] !== tag) same = false;
      const built = kept ?? line(tag, held?.head ?? tileHead(this.lane.key, tag), tiles[at], from, to, wanted.width, cell);
      if (!kept) this.made.set(built, { tiles: tiles[at], from, to, width: wanted.width, cell });
      lines.set(tag, built);
    });
    this.assembled = { binHours: wanted.binHours, first: wanted.first, last: wanted.last, width: wanted.width, cell: wanted.cell };
    this.failure = null;
    if (
      same && wasSettled
      && this.told.failure === null
      && this.told.refused === (this.ranked?.refused ?? null)
      && this.told.from === (this.ranked?.from ?? null)
      && this.told.until === (this.ranked?.until ?? null)
    ) return;
    if (!same) this.lines = lines;
    this.notify();
  }

  private notify(): void {
    this.told = {
      failure: this.failure,
      refused: this.ranked?.refused ?? null,
      from: this.ranked?.from ?? null,
      until: this.ranked?.until ?? null,
    };
    this.changed();
  }
}

export function tileBuckets(tile: Tile, out: (ChartBucket | null)[] = []): (ChartBucket | null)[] {
  const { flags, values, hours, scale, binHours } = tile;
  let present = 0, v = 0;
  for (let bin = 0; bin < TILE_BINS; bin++) {
    const flag = flags[bin];
    if (!(flag & PRESENT)) { out.push(null); continue; }
    const start = tile.firstHour + bin * binHours, h = present * 5, level = (flag & LEVEL) !== 0;
    const first = values[v] / scale;
    out.push({ firstHour: start + hours[h], lastHour: start + hours[h + 1], lastValueHour: start + hours[h + 2],
      minHour: start + hours[h + 3], maxHour: start + hours[h + 4], firstValue: first, lastValue: level ? first : values[v + 1] / scale,
      minValue: level ? first : values[v + 2] / scale, maxValue: level ? first : values[v + 3] / scale,
      firstBreak: (flag & FIRST_BREAK) !== 0, hasBreak: (flag & HAS_BREAK) !== 0 });
    present++; v += level ? 1 : 4;
  }
  return out;
}

export function tileRuns(tile: Tile, out: Run[] = []): Run[] {
  const { flags, values, scale } = tile;
  let at = 0;
  for (let bin = 0; bin < TILE_BINS; bin++) {
    const flag = flags[bin];
    if (!(flag & PRESENT)) continue;
    const hour = tile.firstHour + bin;
    if (!(flag & RUN)) { out[out.length - 1].lastHour = hour; continue; }
    const value = values[at++] / scale, held = out.at(-1);
    if (flag & SEAM && held && held.lastHour + 1 === hour) held.lastHour = hour;
    else out.push({ firstHour: hour, lastHour: hour, value, breakBefore: (flag & FIRST_BREAK) !== 0 });
  }
  return out;
}

export function hourlyBuckets(runs: readonly Run[], from: number, to: number): (ChartBucket | null)[] {
  const out: (ChartBucket | null)[] = new Array<ChartBucket | null>(to - from + 1).fill(null);
  for (const run of runs) {
    const first = Math.max(from, run.firstHour);
    for (let hour = first; hour <= Math.min(to, run.lastHour); hour++) out[hour - from] = { firstHour: hour, lastHour: hour, lastValueHour: hour,
      minHour: hour, maxHour: hour, firstValue: run.value, lastValue: run.value, minValue: run.value, maxValue: run.value,
      firstBreak: hour === first && run.breakBefore === true, hasBreak: false };
  }
  return out;
}

function tileDrops(tile: Tile, out: [number, number, bigint][]): void {
  if (!tile.marks) return;
  let ordinal = BigInt(tile.marks.before);
  for (const [bin, count] of tile.marks.bins) {
    out.push([tile.firstHour + bin * tile.binHours, count, ordinal]);
    ordinal += BigInt(count);
  }
}

export function cellClusters(drops: readonly (readonly [number, number, bigint])[], binHours: number, cell: number): MarkCluster[] {
  const out: MarkCluster[] = [], hours = binHours * cell;
  let at = 0;
  while (at < drops.length) {
    const index = Math.floor(drops[at][0] / hours), bins: [number, number][] = [];
    let count = 0, end = at;
    while (end < drops.length && Math.floor(drops[end][0] / hours) === index) {
      bins.push([drops[end][0] + binHours - 1, drops[end][1]]);
      count += drops[end][1]; end++;
    }
    out.push({ firstHour: drops[at][0], lastHour: bins[bins.length - 1][0], firstOrdinal: drops[at][2].toString(), count: String(count), bins });
    at = end;
  }
  return out;
}

function line(tag: string, head: string, tiles: readonly Tile[], from: number, to: number, width: number, cell: number | null): TiledLine {
  let buckets: (ChartBucket | null)[] = [];
  const missing: MissingSpan[] = [], partial: MissingSpan[] = [], parts: TilePart[] = [], seen = new Set<string>(), runs: Run[] = [], drops: [number, number, bigint][] = [];
  const hourly = tiles[0].hourly;
  for (const tile of tiles) {
    if (hourly) tileRuns(tile, runs); else tileBuckets(tile, buckets);
    if (cell !== null) tileDrops(tile, drops);
    for (const span of tile.missing) {
      const held = missing.at(-1);
      if (held && held.reason === span.reason && held.lastHour + 1 === span.firstHour) held.lastHour = span.lastHour;
      else missing.push({ ...span });
    }
    for (const span of tile.partial) {
      const held = partial.at(-1);
      if (held && held.reason === span.reason && held.lastHour + 1 === span.firstHour) held.lastHour = span.lastHour;
      else partial.push({ ...span });
    }
    for (const part of tile.parts) {
      const key = `${part.firstHour}:${part.lastHour}:${part.slot}:${part.countryId}`;
      if (!seen.has(key)) { seen.add(key); parts.push(part); }
    }
  }
  const binHours = tiles[0].binHours;
  if (hourly) buckets = hourlyBuckets(runs, from, to);
  const summary: ChartSummary = { from, to, width, buckets, ...(hourly ? { runs } : {}),
    tiles: { binHours, valueAt: hour => valueAtHead(head, summary, binHours, hour) } };
  return { tag, head, decimals: tiles[0].decimals, summary, missing, ...(partial.length ? { partial } : {}), parts, marks: cell !== null ? { from, to, width, clusters: cellClusters(drops, binHours, cell), tiles: true } : null };
}

const caches = new WeakMap<object, TileCache>();
export function tileCache(client: object): TileCache {
  client = (client as { base?: object }).base ?? client;
  let cache = caches.get(client);
  if (!cache) caches.set(client, cache = new TileCache());
  return cache;
}
