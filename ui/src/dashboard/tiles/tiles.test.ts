import assert from 'node:assert/strict';
import test from 'node:test';
import type { SeriesTileReply } from '../../generated/dashboard';
import { countryFromKey, countryKey } from '../countryKey.ts';
import type { ChartBucket } from '../../charts/chartSummary';
import { TileCache } from './cache.ts';
import { valueAtHead } from './head.ts';
import { FIRST_BREAK, HAS_BREAK, LEVEL, PRESENT, TILE_BINS, binHoursOf, tilesOf } from './tile.ts';
import type { Tile } from './tile.ts';
import { TileView, tileBuckets } from './view.ts';
import type { TileLane, TileViewport } from './view.ts';
import { watchBoundary } from '../widgetTime.ts';
import type { PlaybackController } from '../playback';
import { topTileProof } from '../../families/host/tiledState.ts';
import { serializeTiledBySource } from '../../families/sceneTiles.ts';

function reply(tags: readonly string[], binHours: number, index: number, lastHour: number, value: (tag: number, hour: number) => number | null): SeriesTileReply {
  const first = index * TILE_BINS * binHours;
  const flags: number[] = [], values: number[] = [], hours: number[] = [];
  tags.forEach((_, tag) => {
    for (let bin = 0; bin < TILE_BINS; bin++) {
      const start = first + bin * binHours, end = Math.min(start + binHours - 1, lastHour);
      const at = start <= lastHour ? value(tag, start) : null;
      if (at === null) { flags.push(0); continue; }
      const level = bin % 11 === 5;
      flags.push(PRESENT | (bin % 50 === 0 ? FIRST_BREAK : 0) | (bin % 70 === 3 ? HAS_BREAK : 0) | (level ? LEVEL : 0));
      values.push(...level ? [at] : [at, at + 2, at - 1, at + 5]);
      hours.push(0, end - start, end - start, 0, Math.min(1, end - start));
    }
  });
  const bytes = new Uint8Array(flags.length + values.length * 4 + hours.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(flags);
  values.forEach((value, at) => view.setInt32(flags.length + at * 4, value, true));
  hours.forEach((hour, at) => view.setUint16(flags.length + values.length * 4 + at * 2, hour, true));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const last = first + TILE_BINS * binHours - 1;
  return { branchId: '1', measure: 'politicalPower', decimals: 2, binHours, index, firstHour: first, immutable: last < lastHour,
    filled: first <= lastHour ? Math.min(last, lastHour) : null, rawValues: true, hourBytes: 2,
    lines: tags.map(tag => ({ country: countryFromKey(tag), missing: [], partial: [], parts: [{ firstHour: first, lastHour: last, slot: 1, countryId: 1, segmentFirstHour: first }] })), bins: btoa(binary) };
}

const value = (tag: number, hour: number) => hour % 977 < 20 ? null : (hour * 7 + tag * 1000) % 50_000 - 25_000;

function lane(tags: readonly string[], lastHour: number, options: { hold?: boolean } = {}) {
  const asked: { binHours: number; index: number; tags: readonly string[] }[] = [];
  const held: (() => void)[] = [];
  const out: TileLane & { asked: typeof asked; release(): void } = {
    key: 'source|1|1|measure', tags, lastHour, asked,
    ask(binHours, index, tags) {
      asked.push({ binHours, index, tags });
      const made = reply(tags, binHours, index, lastHour, value);
      if (!options.hold) return Promise.resolve(made);
      return new Promise(resolve => held.push(() => resolve(made)));
    },
    release() { for (const resolve of held.splice(0)) resolve(); },
  };
  return out;
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const TAGS = ['GER', 'ITA', 'JAP', 'SOV', 'USA', 'ENG', 'FRA', 'CHI'];
const LAST = 105_541;

test('tile views share a compact key for identical membership and release it with the last view and tile', async () => {
  const cache = new TileCache(0);
  const overlords = Array.from({ length: 1500 }, (_, slot) => [slot, [{ firstHour: 100, lastHour: 600 }]]);
  const config = () => 'source|1|1|' + JSON.stringify({ kind: 'autonomy-lines', overlords });
  const viewport = { from: 100, to: 110, end: 110, width: 20 };
  const open = () => {
    const held = lane(['AAA'], 600, { hold: true });
    const view = new TileView(cache, { ...held, key: config() }, () => {});
    view.setView(viewport);
    return { view, held };
  };
  const first = open(), same = open();
  assert.equal(same.held.asked.length, 0);
  const [key] = cache.inflight.keys();
  assert.ok(key && key.length < 30, 'individual tile keys do not contain the family configuration');
  overlords[1499] = [1499, [{ firstHour: 101, lastHour: 600 }]];
  const changed = open();
  assert.equal(changed.held.asked.length, 1, 'one different membership date needs a different tile');
  first.view.close();
  first.held.release();
  changed.held.release();
  await settle();
  assert.ok(cache.has(key), 'the second view still holds the tile');
  same.view.close();
  changed.view.close();
  assert.equal(cache.size, 0);
  overlords[1499] = [1499, [{ firstHour: 100, lastHour: 600 }]];
  const next = open();
  assert.ok(!cache.inflight.has(key), 'closing the last view and evicting its tile released the old configuration');
  next.held.release();
  await settle();
  cache.forget('another-source|');
  assert.equal(cache.size, 1);
  cache.forget('source|');
  assert.equal(cache.size, 0, 'source invalidation reaches compact keys');
  next.view.close();
});

function following(head: number, days = 365): TileViewport {
  const span = days * 24;
  const end = Math.min(LAST, Math.max(span, head));
  const from = Math.max(0, end - span);
  return { from: Math.floor(from), to: Math.floor(Math.min(end, head)), end: Math.floor(end), width: 600 };
}

test('a strip holds the whole chart at its current bin width and projects a seek without asking', async () => {
  const cache = new TileCache(), source = lane(['GER'], LAST);
  const view = new TileView(cache, source, () => {});
  const initial = following(10000);
  view.setView(initial);
  await settle();
  const claim = cache.claim(() => assert.fail('The fixture fits'));
  const project = await view.holdStrip(0, [], claim, () => assert.fail('The fixture uses the lane client'));
  const before = source.asked.length;
  for (const hour of [8761, 24_000, 77_123, LAST]) {
    const viewport = following(hour);
    const exact = new TileView(new TileCache(), lane(['GER'], LAST), () => {});
    exact.setView(initial);
    await settle();
    exact.setView(viewport);
    await settle();
    assert.deepEqual(serializeTiledBySource({ main: project(viewport, hour).lines }),
      serializeTiledBySource({ main: exact.current! }), `chart fields at ${hour}`);
    exact.close();
  }
  assert.equal(source.asked.length, before);
  assert.ok(cache.stripBytes > 0 && cache.bytes <= cache.cap);
  claim.release();
  assert.equal(cache.stripBytes, 0);
  const rolling = cache.claim(() => assert.fail('The rolling chart holds no tiles'));
  await assert.rejects(view.holdStrip(0, [0, LAST], rolling, () => assert.fail('The fixture uses the lane client'),
    { first: 0, hours: 8760 }), /rolling chart changes tile width/);
  assert.equal(source.asked.length, before);
  assert.equal(cache.stripBytes, 0);
  rolling.release();
  view.close();
});

test('the cache releases a strip claim when a foreground tile needs its budget', () => {
  const cache = new TileCache(600);
  const tile = (key: string) => ({ ...tilesOf(reply(['GER'], 6, 0, 0, value), ['GER'], 6, 0, () => key)[0]!, bytes: 300 });
  let losses = 0;
  const claim = cache.claim(() => { losses++; });
  claim.put(tile('strip'));
  cache.pin(['first', 'second', 'third']);
  cache.put(tile('first'));
  cache.put(tile('second'));
  assert.equal(losses, 1);
  assert.equal(claim.active, false);
  assert.equal(cache.stripBytes, 0);
  assert.equal(cache.bytes, cache.cap);
  assert.deepEqual(['first', 'second', 'strip'].map(key => cache.has(key)), [true, true, false]);
  const tooLarge = cache.claim(() => assert.fail('Admission fails before claiming bytes'));
  assert.throws(() => tooLarge.put(tile('third')), /tile budget/i);
  assert.equal(cache.bytes, cache.cap);
});

test('a held chart projects the lookahead tile at the last recorded hour before a trailing gap', async () => {
  const cache = new TileCache();
  const source = { ...lane(['GER'], 249), lastHour: 260 };
  const view = new TileView(cache, source, () => {});
  view.setView({ from: 0, to: 120, end: 120, width: 600 });
  await settle();
  const claim = cache.claim(() => assert.fail('The fixture fits'));
  const project = await view.holdStrip(0, [0, 249], claim, () => assert.fail('The fixture uses the lane client'));
  const viewport = { from: 0, to: 249, end: 249, width: 600 };
  const before = source.asked.length;
  const held = project(viewport, 249);
  assert.equal(source.asked.length, before);
  view.setView(viewport);
  await settle();
  assert.deepEqual(serializeTiledBySource({ main: held.lines }), serializeTiledBySource({ main: view.current! }));
  claim.release();
  view.close();
});

test('a tile reply becomes one tile per tag, each owning its arrays, and reads back as its bins', () => {
  const made = reply(['GER', 'ITA'], 12, 3, LAST, value);
  const tiles = tilesOf(made, ['GER', 'ITA'], 12, 3, tag => tag);
  assert.equal(tiles.length, 2);
  for (const [at, tile] of tiles.entries()) {
    assert.equal(tile.flags.length, TILE_BINS);
    assert.equal(tile.flags.buffer.byteLength, TILE_BINS, 'its own buffer, not a view of the reply');
    const buckets = tileBuckets(tile);
    for (let bin = 0; bin < TILE_BINS; bin++) {
      const start = 3 * TILE_BINS * 12 + bin * 12, expected = value(at, start), level = bin % 11 === 5;
      if (expected === null) { assert.equal(buckets[bin], null); continue; }
      assert.deepEqual(buckets[bin], { firstHour: start, lastHour: start + 11, lastValueHour: start + 11, minHour: start, maxHour: start + 1,
        firstValue: expected / 100, lastValue: (expected + (level ? 0 : 2)) / 100, minValue: (expected - (level ? 0 : 1)) / 100,
        maxValue: (expected + (level ? 0 : 5)) / 100,
        firstBreak: bin % 50 === 0, hasBreak: bin % 70 === 3 } satisfies ChartBucket);
    }
  }
  assert.throws(() => tilesOf(made, ['GER'], 12, 3, tag => tag), /malformed/);
  assert.throws(() => tilesOf({ ...made, bins: made.bins.slice(0, -8) }, ['GER', 'ITA'], 12, 3, tag => tag), /malformed/);
});

test('a view asks only the tiles it lacks, one request per tile for every tag lacking it', async () => {
  const cache = new TileCache();
  const first = lane(TAGS, LAST);
  const view = new TileView(cache, first, () => {});
  view.setView({ from: 0, to: 8759, end: 8759, width: 600 });
  await settle();
  const binHours = binHoursOf(8760, 600);
  const tiles = Math.floor(8759 / (TILE_BINS * binHours)) + 1;
  assert.equal(first.asked.length, tiles);
  assert.ok(first.asked.every(ask => ask.tags.length === TAGS.length));
  const second = lane(['GER', 'ITA', 'POL'], LAST);
  const other = new TileView(cache, { ...second, key: first.key }, () => {});
  other.setView({ from: 0, to: 8759, end: 8759, width: 600 });
  await settle();
  assert.deepEqual(second.asked.map(ask => [ask.index, ask.tags]), Array.from({ length: tiles }, (_, index) => [index, ['POL']]));
  const span = TILE_BINS * binHours;
  other.setView({ from: span, to: span + 8759, end: span + 8759, width: 600 });
  await settle();
  assert.deepEqual(second.asked.slice(tiles).map(ask => [ask.index, ask.tags]), [[tiles, ['GER', 'ITA', 'POL']]]);
});

test('a top of tiles takes its countries from the ranked reply, keeps them while the hour stays inside their proof, and asks again only outside it', async () => {
  const cache = new TileCache();
  const ranks: { hour: number; index: number }[] = [];
  const winner = countryKey(9), other = countryKey(3), newcomer = countryKey(7);
  const named = (hour: number) => hour < 5000 ? [winner, other] : [newcomer, winner];
  const base = lane([], LAST);
  const top: TileLane = { ...base, top: { ask(binHours, index, hour) {
    ranks.push({ hour, index });
    const tags = named(hour);
    return Promise.resolve({ ...reply(tags, binHours, index, LAST, value), ranking: { hour, from: hour < 5000 ? 0 : 5000, until: hour < 5000 ? 4999 : LAST, refused: null } });
  } } };
  let renders = 0;
  const view = new TileView(cache, top, () => { renders++; });
  view.setView({ from: 0, to: 8759, end: 8759, width: 600 });
  await settle();
  assert.equal(view.current, null, 'nothing is drawn before the top is named');
  view.setHour(100);
  await settle();
  assert.deepEqual([...view.current!.keys()], [winner, other]);
  assert.deepEqual(view.top, { tags: [winner, other], hour: 100, from: 0, until: 4999, refused: null });
  assert.ok(base.asked.length && base.asked.every(ask => ask.tags.every(key => key === winner || key === other)));
  const selected = lane(['GER', winner], LAST);
  const ordinary = new TileView(cache, selected, () => {});
  ordinary.setView({ from: 0, to: 8759, end: 8759, width: 600 });
  await settle();
  assert.ok(selected.asked.length && selected.asked.every(ask => ask.tags.length === 1 && ask.tags[0] === 'GER'), 'only the ordinary tag needs tiles, the slot already holds its own history');
  assert.ok(renders > 0);
  view.setHour(4999);
  await settle();
  assert.equal(ranks.length, 1, 'an hour inside the proof asks nothing');
  const before = base.asked.length, held = view.current!.get(winner);
  view.setHour(6000);
  await settle();
  assert.equal(ranks.length, 2);
  assert.deepEqual([...view.current!.keys()], [newcomer, winner]);
  assert.ok(base.asked.slice(before).every(ask => ask.tags.every(tag => tag === newcomer)), 'a country already held keeps its tiles; only the newcomer is asked');
  assert.equal(view.current!.get(winner), held, 'a country still ranked keeps its line object, so the lane is not sent it again');
  const shown = view.current, drawn = renders;
  view.retry();
  await settle();
  assert.equal(view.current, shown, 'assembling unchanged tiles keeps the lines');
  assert.equal(renders, drawn, 'and publishes nothing');

  const rankedBefore = ranks.length, groupedBefore = base.asked.length;
  const claim = cache.claim(() => assert.fail('The ranked fixture fits'));
  const project = await view.holdStrip(0, [100, 4999, 5000, LAST], claim, () => assert.fail('The fixture uses the lane client'));
  assert.deepEqual(ranks.slice(rankedBefore).map(rank => rank.hour), [100, 5000]);
  const grouped = base.asked.slice(groupedBefore).map(ask => ask.index);
  assert.equal(grouped.length, new Set(grouped).size);
  const viewport = { from: 0, to: 8759, end: 8759, width: 600 };
  assert.deepEqual([...project(viewport, 4999).lines.keys()], [winner, other]);
  assert.deepEqual([...project(viewport, 5000).lines.keys()], [newcomer, winner]);
  claim.release();

  const rolling = (hour: number) => ({ from: hour - 720, to: hour, end: hour, width: 600 });
  const rollingView = new TileView(cache, { ...top, lastHour: 5400 }, () => {});
  rollingView.setView(rolling(4991));
  rollingView.setHour(4991);
  await settle();
  const rollingClaim = cache.claim(() => assert.fail('The rolling fixture fits'));
  const rollingProject = await rollingView.holdStrip(0, [4991, 5075], rollingClaim, () => assert.fail('The fixture uses the lane client'),
    { first: 0, hours: 720 });
  const rollingHeld = rollingProject(rolling(5075), 5075).lines;
  rollingView.setView(rolling(5075));
  rollingView.setHour(5075);
  await settle();
  assert.deepEqual(serializeTiledBySource({ main: rollingHeld }), serializeTiledBySource({ main: rollingView.current! }));
  rollingClaim.release();
  rollingView.close();
});

test('a failing top-rank read does not re-ask the same hour when setHour runs again, retries on retry(), and asks a new hour', async () => {
  const cache = new TileCache();
  const asked: number[] = [];
  let fail = true;
  const base = lane([], LAST);
  const top: TileLane = { ...base, top: { ask(binHours, index, hour) {
    asked.push(hour);
    if (fail) return Promise.reject(new Error('not recorded'));
    return Promise.resolve({ ...reply(['GER'], binHours, index, LAST, value), ranking: { hour, from: 0, until: hour + 49, refused: null } });
  } } };
  let changes = 0;
  let currentHour = 100;
  const view = new TileView(cache, top, () => {
    changes++;
    if (changes < 5) view.setHour(currentHour);
  });
  view.setView({ from: 0, to: 8759, end: 8759, width: 600 });
  view.setHour(currentHour);
  await settle();
  await settle();
  assert.deepEqual(asked, [100], 'calling setHour(100) again after a failure does not loop');
  assert.ok(view.error instanceof Error);
  currentHour = 200;
  view.setHour(currentHour);
  await settle();
  assert.deepEqual(asked, [100, 200], 'a different hour is still asked');
  fail = false;
  view.retry();
  await settle();
  assert.deepEqual(asked, [100, 200, 200], 'retry() re-asks the failed top-rank hour');
  assert.equal(view.error, null);
  assert.deepEqual([...view.current!.keys()], ['GER']);
  view.close();

  fail = true;
  const errors: unknown[] = [];
  const followed = new TileView(cache, { ...top, followRank: 'head' }, () => errors.push(followed.error));
  followed.setView({ from: 0, to: 8759, end: 8759, width: 600 });
  followed.setHour(300);
  await settle();
  assert.ok(errors.at(-1) instanceof Error);
  followed.setHour(301, true);
  assert.equal(errors.at(-1), null, 'Play clears an exact rank error before it can block the followed head');
  followed.setFollowedRank(301, { tags: ['GER'], refused: null, hour: 301, from: 301, until: 301 });
  await settle();
  assert.equal(followed.settled, true);
  assert.deepEqual(asked, [100, 200, 200, 300]);

  fail = false;
  followed.setHour(300, false);
  await settle();
  const held = followed.current;
  assert.ok(held);
  fail = true;
  followed.setHour(350, false);
  await settle();
  assert.ok(errors.at(-1) instanceof Error);
  followed.setHour(300, true);
  assert.equal(errors.at(-1), null, 'Play republishes the cleared error alongside the proved rank');
  assert.equal(followed.current, held);
  assert.deepEqual(asked, [100, 200, 200, 300, 300, 350]);
  followed.close();
});

test('a top whose lines stay the same still tells the chart when its refusal or failure clears', async () => {
  const cache = new TileCache();
  let mode: 'refused' | 'empty' | 'ger' | 'fail' = 'refused';
  const base = lane([], LAST);
  const top: TileLane = { ...base, top: { ask(binHours, index, hour) {
    if (mode === 'fail') return Promise.reject(new Error('not recorded'));
    const tags = mode === 'ger' ? ['GER'] : [];
    return Promise.resolve({ ...reply(tags, binHours, index, LAST, value), ranking: { hour, from: hour, until: hour, refused: mode === 'refused' ? 'Not recorded at this hour.' : null } });
  } } };
  let changes = 0;
  const view = new TileView(cache, top, () => { changes++; });
  view.setView({ from: 0, to: 8759, end: 8759, width: 600 });
  const at = async (hour: number, next: typeof mode) => { mode = next; const before = changes; view.setHour(hour); await settle(); await settle(); return changes - before; };
  await at(10, 'refused');
  assert.equal(view.top?.refused, 'Not recorded at this hour.');
  assert.ok(await at(20, 'empty') > 0, 'an empty ranking after a refused one is told, though both draw no line');
  assert.equal(view.top?.refused, null);
  await at(30, 'ger');
  const germany = view.current!.get('GER');
  assert.ok(await at(40, 'fail') > 0);
  assert.ok(view.error instanceof Error);
  assert.ok(await at(50, 'ger') > 0, 'a ranking after a failure is told, though its line is the one already held');
  assert.equal(view.error, null);
  assert.equal(view.current!.get('GER'), germany);
});

test('an immutable tile is never asked twice, the last tile is asked again only when the history grows past it', async () => {
  const cache = new TileCache();
  const binHours = 12, span = TILE_BINS * binHours;
  const live = lane(['GER'], 2 * span + 100);
  const view = new TileView(cache, live, () => {});
  view.setView({ from: 0, to: 2 * span + 100, end: 2 * span + 100, width: Math.floor((2 * span + 101) / binHours) });
  await settle();
  assert.deepEqual(live.asked.map(ask => ask.index), [0, 1, 2]);
  view.close();
  const again = new TileView(cache, live, () => {});
  again.setView({ from: 0, to: 2 * span + 100, end: 2 * span + 100, width: Math.floor((2 * span + 101) / binHours) });
  await settle();
  assert.equal(live.asked.length, 3);
  again.close();
  const grown = lane(['GER'], 2 * span + 900);
  const later = new TileView(cache, { ...grown, key: live.key }, () => {});
  later.setView({ from: 0, to: 2 * span + 100, end: 2 * span + 100, width: Math.floor((2 * span + 101) / binHours) });
  await settle();
  assert.deepEqual(grown.asked.map(ask => ask.index), [2]);
});

test('the cache evicts the least recently used tile at its cap and never a tile a view holds', async () => {
  const tile = (key: string, bytes: number): Tile => ({ key, tag: 'GER', binHours: 6, index: 0, firstHour: 0, immutable: true, filled: 1535,
    flags: new Uint8Array(0), hourly: false, values: new Int32Array(0), scale: 1, decimals: 0, hours: new Uint16Array(0), missing: [], partial: [], parts: [], bytes });
  const cache = new TileCache(300);
  cache.put(tile('a', 100)); cache.put(tile('b', 100)); cache.put(tile('c', 100));
  cache.pin(['a']);
  cache.get('b');
  cache.put(tile('d', 100));
  assert.deepEqual(['a', 'b', 'c', 'd'].filter(key => cache.has(key)), ['a', 'b', 'd'], 'c was used least recently; a is held');
  assert.ok(cache.bytes <= cache.cap);
  cache.pin(['b', 'd']);
  cache.put(tile('e', 100));
  assert.deepEqual(['a', 'b', 'd', 'e'].filter(key => cache.has(key)), ['a', 'b', 'd']);
  cache.pin(['e']);
  cache.put(tile('e', 100));
  assert.equal(cache.bytes, 400, 'every tile a view holds stays');
  cache.unpin(['a', 'b', 'd', 'e']);
  assert.ok(cache.bytes <= cache.cap);
  assert.ok(cache.has('e'), 'the most recently used stays');

  const small = new TileCache(4 * 1024 * 1024), followed = lane(TAGS, LAST);
  const view = new TileView(small, followed, () => {});
  let most = 0;
  for (let head = 24; head <= LAST; head += 24) {
    view.setView(following(head, 7 * 365));
    if (head % 2400 === 0) await settle();
    most = Math.max(most, small.bytes);
  }
  await settle();
  assert.ok(most <= small.cap, `${most} bytes held against a cap of ${small.cap}`);
});

test('a chart following the head asks one tile per 256 bins of travel and nothing else, and renders only when one lands', async () => {
  const cache = new TileCache(), followed = lane(TAGS, LAST);
  let renders = 0, binHours = 0, sinceTile = 0, quiet = 0, frames = 0;
  const view = new TileView(cache, followed, () => { renders++; });
  view.setView(following(8760));
  await settle();
  const initial = followed.asked.length;
  for (let head = 8784; head <= LAST; head += 24) {
    const before = followed.asked.length, rendered = renders;
    frames++;
    const at = following(head);
    binHours ||= binHoursOf(at.end - at.from + 1, at.width);
    view.setView(at);
    await settle();
    if (followed.asked.length === before) {
      quiet++;
      assert.equal(renders, rendered, `the head moving inside held tiles renders nothing (hour ${head})`);
    } else {
      assert.equal(followed.asked.length - before, 1, `one tile asked at hour ${head}`);
      sinceTile = 0;
    }
    sinceTile += 24;
  }
  const span = TILE_BINS * binHours, travel = LAST - 8760, moving = followed.asked.length - initial;
  assert.ok(moving <= Math.ceil(travel / span), `${moving} tiles for ${travel} hours of travel in tiles of ${span} hours`);
  assert.ok(moving >= Math.floor(travel / span) - 1);
  assert.equal(quiet + moving, frames, 'every frame asks nothing but those crossing into a tile');
  assert.ok(renders <= initial + moving, `${renders} renders for ${initial + moving} tiles landed, none per frame`);
  assert.ok(sinceTile <= span);
  console.log(`following at 1,440 h/s: ${initial} tiles to open, then ${moving} tile requests over ${travel} hours (${binHours}-hour bins, a tile every ${(span / 1440).toFixed(2)} s), ${renders} renders`);
});

function drawingIn(head: number, width: number): TileViewport {
  const end = Math.min(LAST, Math.max(14 * 24, head));
  return { from: 0, to: Math.floor(Math.min(end, head)), end: Math.floor(end), width };
}

test('a chart drawing in keeps its bins as the head grows it, so its tiles are those the head crosses, as the suite judges them', async () => {
  const cache = new TileCache(), drawn = lane(['GER'], LAST);
  const view = new TileView(cache, drawn, () => {});
  view.setView(drawingIn(30_000, 450));
  await settle();
  const opened = drawn.asked.length, start = drawn.asked[0]!.binHours;
  for (let head = 30_015; head <= 41_520; head += 15) { view.setView(drawingIn(head, 450)); await settle(); }
  const playing = drawn.asked.slice(opened);
  assert.ok(playing.every(ask => ask.binHours === start), `the bins held: ${[...new Set(playing.map(ask => ask.binHours))].join(', ')} hours`);
  const allowed = Math.floor(11_520 / (start * TILE_BINS)) + 2;
  assert.ok(playing.length <= allowed, `${playing.length} tiles asked while playing, ${allowed} allowed`);
  assert.equal(new Set(playing.map(ask => ask.index)).size, playing.length, 'no tile asked twice');

  const grown = lane(['GER'], LAST), again = new TileView(new TileCache(), grown, () => {});
  again.setView(drawingIn(2_000, 450));
  const held = binHoursOf(2_001, 450);
  again.setView(drawingIn(7_000, 450));
  assert.equal(grown.asked.at(-1)!.binHours, held, 'under four bins a pixel, the bins held');
  again.setView(drawingIn(10_000, 450));
  assert.equal(grown.asked.at(-1)!.binHours, binHoursOf(10_001, 450), 'past four bins a pixel, new bins');
  again.setView({ from: 50_000, to: 50_000 + 7 * 24, end: 50_000 + 7 * 24, width: 450 });
  assert.equal(grown.asked.at(-1)!.binHours, binHoursOf(7 * 24 + 1, 450), 'zoomed in, finer bins at once');
});

test('the head moving inside a tile asks nothing; crossing into a new tile asks exactly one', async () => {
  const cache = new TileCache(), followed = lane(['GER'], LAST, { hold: true });
  const view = new TileView(cache, followed, () => {});
  const at = following(20_000);
  const binHours = binHoursOf(at.end - at.from + 1, at.width), span = TILE_BINS * binHours;
  view.setView(at);
  followed.release(); await settle();
  const asked = followed.asked.length;
  const next = (Math.floor((at.to + 32 * binHours) / span) + 1) * span;
  for (let head = 20_000; head + 32 * binHours < next; head += 6) view.setView(following(head));
  assert.equal(followed.asked.length, asked, 'nothing asked inside the tiles held');
  view.setView(following(next - 32 * binHours));
  view.setView(following(next - 31 * binHours));
  assert.equal(followed.asked.length, asked + 1, 'one tile asked, once, while it is in flight');
  assert.equal(followed.asked.at(-1)!.index, next / span);
  followed.release(); await settle();
});

test('a tiled line answers the head value from the tile summary', async () => {
  const cache = new TileCache(), followed = lane(TAGS, LAST);
  const view = new TileView(cache, followed, () => {});
  const head = 50_000.5, at = following(head);
  view.setView(at);
  await settle();
  const lines = [...view.current!.values()];
  const binHours = binHoursOf(at.end - at.from + 1, at.width);
  const shown = lines[0].summary.tiles!.valueAt(head);
  const bucket = lines[0].summary.buckets[Math.floor(head / binHours) - Math.floor(lines[0].summary.from / binHours) - 1]!.lastValue;
  assert.equal(shown, bucket);
});

test('at hourly zoom a historical hour is answered from its own bucket, a missing one as missing', () => {
  const at = (hour: number, value: number): ChartBucket => ({ firstHour: hour, lastHour: hour, firstValue: value, lastValue: value, lastValueHour: hour,
    minHour: hour, minValue: value, maxHour: hour, maxValue: value, firstBreak: false, hasBreak: false });
  const summary = { from: 100, buckets: [at(100, 5), at(101, 7), null] };
  assert.equal(valueAtHead('hourly', summary, 1, 101), 7);
  assert.equal(valueAtHead('hourly', summary, 1, 102), null);
});

test('a page chart joining a tile the prepare lane holds waiting sends it at once; a prepared chart joining it does not', async () => {
  const cache = new TileCache();
  const promoted: { index: number; tags: readonly string[] }[] = [];
  const held = lane(['GER', 'ITA'], LAST, { hold: true });
  const preparedLane: TileLane = { ...held, prepared: true, promote: (_binHours, index, tags) => promoted.push({ index, tags }) };
  const view: TileViewport = { from: 0, to: 8759, end: 8759, width: 600 };
  new TileView(cache, preparedLane, () => {}).setView(view);
  const asked = held.asked.map(ask => ({ index: ask.index, tags: ask.tags }));
  assert.ok(asked.length > 0);
  new TileView(cache, { ...lane(['GER'], LAST), key: held.key, prepared: true }, () => {}).setView(view);
  assert.deepEqual(promoted, [], 'another prepared chart waits its turn with the lane');
  const page = lane(['GER'], LAST);
  new TileView(cache, { ...page, key: held.key }, () => {}).setView(view);
  assert.deepEqual(page.asked, [], 'the page asks nothing of its own: it joins the flight');
  assert.deepEqual(promoted, asked, 'every tile it waits on goes now');
  held.release();
  await settle();
  assert.equal(cache.joins.size, 0, 'a landed tile leaves nothing to send');
});

test('a top tile view survives an empty first window, stays quiet through the second empty interval under watchBoundary, and installs later data without remounting', async () => {
  const cache = new TileCache();
  const topAsked: number[] = [];
  let applyCount = 0;
  let clockHour = 50;
  let sequence = 1;
  const frameListeners = new Set<() => void>();
  const anchorListeners = new Set<() => void>();
  const clock = {
    getHour: () => clockHour,
    getSnapshot: () => ({ hour: clockHour, sequence, playing: true, hoursPerSecond: 24, seekSequence: 0 }),
    subscribeFrame: (fn: () => void) => { frameListeners.add(fn); return () => { frameListeners.delete(fn); }; },
    subscribe: (fn: () => void) => { anchorListeners.add(fn); return () => { anchorListeners.delete(fn); }; },
  } as unknown as PlaybackController;
  const advanceTo = (hour: number) => {
    clockHour = hour;
    sequence++;
    for (const fn of [...frameListeners]) fn();
  };

  const base = lane([], 1000);
  const topLane: TileLane = {
    ...base,
    key: 'source|1|1|top-empty-first',
    top: {
      ask(binHours, index, hour) {
        topAsked.push(hour);
        if (hour <= 100) {
          return Promise.resolve({ ...reply([], binHours, index, 1000, value), ranking: { hour, from: 0, until: 100, refused: null } });
        }
        if (hour <= 200) {
          return Promise.resolve({ ...reply([], binHours, index, 1000, value), ranking: { hour, from: 101, until: 200, refused: null } });
        }
        return Promise.resolve({ ...reply(['AAA'], binHours, index, 1000, value), ranking: { hour, from: 201, until: 300, refused: null } });
      },
    },
  };

  let stopWatch = () => {};
  let view!: TileView;
  const apply = () => {
    applyCount++;
    view.setHour(Math.floor(clock.getHour()));
  };
  const armWatch = () => {
    stopWatch();
    stopWatch = watchBoundary(
      clock,
      () => topTileProof([view], Math.floor(clock.getHour()), 0, hour => hour, hour => [hour, hour]),
      apply,
    );
  };

  view = new TileView(cache, topLane, () => { armWatch(); });
  view.setView({ from: 0, to: 100, end: 1000, width: 200 });
  apply();
  armWatch();
  await settle();
  assert.equal(view.current?.size, 0, 'the empty first window installs an empty map');
  assert.deepEqual(view.top, { tags: [], hour: 50, from: 0, until: 100, refused: null });

  const afterFirstApply = applyCount;
  for (const hour of [60, 80, 100]) advanceTo(hour);
  assert.equal(applyCount, afterFirstApply, 'boundary watch stays quiet inside the first empty interval');

  advanceTo(101);
  await settle();
  assert.equal(view.current?.size, 0);
  assert.deepEqual(view.top, { tags: [], hour: 101, from: 101, until: 200, refused: null });
  const afterSecondApply = applyCount;
  for (const hour of [120, 150, 200]) advanceTo(hour);
  assert.equal(applyCount, afterSecondApply, 'boundary watch re-arms on the second empty interval and stays quiet through hour 200');

  advanceTo(201);
  await settle();
  assert.deepEqual([...(view.current?.keys() ?? [])], ['AAA'], 'crossing the second empty upper bound installs AAA on the same tile view');
  assert.deepEqual(topAsked, [50, 101, 201]);
  stopWatch();
  view.close();
});

test('followed ranks ask only for newly needed keys and match exactly ranked tiles', async () => {
  const viewport = { from: 80, to: 125, end: 125, width: 100 };
  const before = { tags: ['GER', 'ITA'], hour: 100, from: 100, until: 110, refused: null };
  const after = { tags: ['ITA', 'JAP'], hour: 111, from: 111, until: 115, refused: null };
  const reordered = { tags: ['JAP', 'ITA'], hour: 116, from: 116, until: 120, refused: null };
  const refused = { tags: [], hour: 121, from: 121, until: 125, refused: 'Rank input was not recorded' };
  const rankAt = (hour: number) => hour >= 121 ? refused : hour >= 116 ? reordered : hour >= 111 ? after : before;
  const make = (tags: readonly string[], binHours: number, index: number) =>
    reply(tags, binHours, index, LAST, (at, hour) => value(TAGS.indexOf(tags[at]!), hour));
  const calls: string[][] = [];
  let rankedRequests = 0, exactRequests = 0;
  const exact = new TileView(new TileCache(1024 * 1024), {
    key: 'rank-test', tags: [], lastHour: LAST,
    ask: async (binHours, index, tags) => make(tags, binHours, index),
    top: { ask: async (binHours, index, hour) => {
      exactRequests++;
      const rank = rankAt(hour);
      return { ...make(rank.tags, binHours, index), ranking: { ...rank, hour } };
    } },
  }, () => {});
  const followed = new TileView(new TileCache(1024 * 1024), {
    key: 'rank-test', tags: [], lastHour: LAST, followRank: 'head',
    ask: async (binHours, index, tags) => { calls.push([...tags]); return make(tags, binHours, index); },
    top: { ask: async (binHours, index, hour) => {
      rankedRequests++;
      const rank = rankAt(hour);
      return { ...make(rank.tags, binHours, index), ranking: { ...rank, hour } };
    } },
  }, () => {});
  const choices = (view: TileView) => [...(view.current ?? [])].map(([tag, line]) => [tag, line.summary.buckets]);
  exact.setView(viewport);
  followed.setView(viewport);
  for (const hour of [100, 105, 111, 116, 121]) {
    exact.setHour(hour);
    followed.setHour(hour, true);
    followed.setFollowedRank(hour, { ...rankAt(hour), hour });
    await settle();
    assert.deepEqual(choices(followed), choices(exact), `same picture at ${hour}`);
    assert.equal(followed.top?.refused, exact.top?.refused);
  }
  assert.equal(rankedRequests, 0);
  assert.equal(exactRequests, 4);
  assert.deepEqual(calls, [['GER', 'ITA'], ['JAP']]);
  followed.setFollowedRank(126, after);
  assert.equal(followed.top, null, 'an earlier rank cannot cross a gap or its proof');
  assert.deepEqual(choices(followed), []);
  followed.setHour(116);
  await settle();
  assert.equal(rankedRequests, 1, 'paused reads still ask the ranked product');
  assert.deepEqual([...followed.current!.keys()], reordered.tags);
  exact.close();
  followed.close();
});
