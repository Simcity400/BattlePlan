import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChartBucket } from '../../charts/chartSummary.ts';
import type { ProductRequest } from '../../dashboard/client.ts';
import { TileCache } from '../../dashboard/tiles/cache.ts';
import { TILE_BINS } from '../../dashboard/tiles/tile.ts';
import { TileView } from '../../dashboard/tiles/view.ts';
import type { TiledLine } from '../../dashboard/tiles/view';
import { setToken } from '../../dashboard/options.ts';
import type { FollowQuery, GatedHour } from '../../dashboard/regionTime.ts';
import { boundTiledSeries, createBoundedReadView, displayedHour } from '../../families/boundedView.ts';
import { compileFollowPlan, readPlanExact, readsWithoutFollow } from '../../families/broker.ts';
import { chartTileLane } from '../../families/host/tiledState.ts';
import type { FamilyPlanContext, PixelBinnedSourceRead, PointSourceRead } from '../../families/plan.ts';
import type { TimeChartProjection, TimeChartWidgetDeclaration } from '../../families/time-chart/declaration.ts';
import { knownValue } from '../../families/value.ts';
import type { StockpileLinesReply } from '../../generated/dashboard';
import { TIME_CHART_VIEWS } from '../manifest/time-chart.ts';
import { stockpileDeclaration } from './stockpileProjection.ts';

const FIRST = 60_000_000;
const HOUR = FIRST + 400;

async function view() {
  const entry = TIME_CHART_VIEWS.find(item => item.kind === 'equipment-stockpile' && item.view === 'time');
  assert.ok(entry, 'the Time view is a time-chart manifest entry');
  const spec = await entry.loadSpec();
  return { projection: spec.projection as TimeChartProjection<unknown>, declaration: spec.declaration as TimeChartWidgetDeclaration<unknown> };
}

function context(options: Record<string, unknown>): FamilyPlanContext {
  const branch = { id: '7', firstHour: FIRST, lastHour: FIRST + 1000 };
  return {
    track: { source: { id: 'src', revision: '1' }, axisOffset: 0, branch },
    branch,
    lastRecordedHour: FIRST + 1000,
    options,
    following: true,
    aux: undefined,
    countryTag: 'GER',
    countryName: 'Germany',
    countries: { tags: ['GER'], membership: { GER: [[FIRST, FIRST + 1000]] } },
    gateSpan: (firstHour: number, lastHour: number) => ({ firstHour, lastHour }),
  } as unknown as FamilyPlanContext;
}

function bucket(firstHour: number, lastHour: number, value: number): ChartBucket {
  return { firstHour, lastHour, firstValue: value, lastValue: value, lastValueHour: lastHour, minHour: firstHour, minValue: value,
    maxHour: firstHour, maxValue: value, firstBreak: false, hasBreak: false };
}

function tiled(tag: string, value: number): TiledLine {
  return { tag, head: 'h', decimals: 5, summary: { from: FIRST, to: HOUR, width: 1, buckets: [bucket(FIRST, HOUR, value)], tiles: { binHours: 96, valueAt: () => null } },
    missing: [], parts: [], marks: null };
}

function reply(hour: number, values: Record<string, number | null>, top: StockpileLinesReply['top']): StockpileLinesReply {
  const keys = Object.keys(values);
  return {
    branchId: '7', hour, measure: 'stock', decimals: 5, nextChange: hour + 24, warnings: [], top,
    lines: keys.map((key, ordinal) => ({ key, name: key === 'rifles' ? 'Infantry equipment' : null, domain: 'land', ordinal,
      value: values[key] ?? null, missing: values[key] == null ? 'The stockpile was not read at this hour.' : null })),
  };
}

test('the Time view asks the product for the main types at the date, and a chosen list by name', async () => {
  const { declaration } = await view();
  const automatic = declaration.sources(context({}), { width: 600, height: 300 } as never);
  const bars = stockpileDeclaration.sources(context({}), { width: 600, height: 300 } as never);
  assert.equal([...automatic.entries, ...bars.entries].filter(entry => readsWithoutFollow(entry.read)).length, 0);
  const compile = (plan: typeof automatic) => compileFollowPlan(plan, query => ({ query: query as FollowQuery, refused: null })).subscriptions.map(sub => [sub.channel, sub.product]);
  assert.deepEqual(compile(automatic), [['panel', 'equipment-stockpile-lines']]);
  assert.deepEqual(compile(bars), [['panel', 'equipment-stockpile-types'], ['panel', 'stockpile-artwork']]);
  const tiles = automatic.entries.find(entry => entry.name === 'stock')!.read as PixelBinnedSourceRead;
  assert.deepEqual(tiles.top, { n: 5 });
  assert.equal(tiles.followRank, 'lines');
  assert.deepEqual(tiles.tags, []);
  assert.deepEqual(tiles.family, { kind: 'equipment-stockpile', measure: 'stock', country: 'GER', included: [], membership: [{ firstHour: FIRST, lastHour: FIRST + 1000 }] });
  const lines = automatic.entries.find(entry => entry.name === 'lines')!.read as PointSourceRead;
  assert.equal(lines.product, 'equipment-stockpile-lines');
  assert.equal(lines.params?.top, 5);
  assert.deepEqual(lines.provenInterval?.({ nextChange: HOUR + 24 }, HOUR), [HOUR, HOUR + 23]);
  assert.deepEqual(lines.provenInterval?.({ nextChange: null }, HOUR), [HOUR, Infinity]);
  const chosen = declaration.sources(context({ chosen: `${setToken('mod#tanks')} ${setToken('rifles')}`, measure: 'share' }), { width: 600, height: 300 } as never);
  const chosenTiles = chosen.entries.find(entry => entry.name === 'stock')!.read as PixelBinnedSourceRead;
  assert.equal(chosenTiles.top, undefined);
  assert.equal(chosenTiles.followRank, undefined);
  assert.deepEqual(chosenTiles.tags, ['mod#tanks', 'rifles'], 'a quoted type key keeps its #');
  assert.equal((chosenTiles.family as { measure: string }).measure, 'share');
  assert.equal((chosen.entries.find(entry => entry.name === 'lines')!.read as PointSourceRead).params?.top, undefined);
});

test('the Time view draws the product’s main types in its order, missing as missing, and hovers the drawn types at the hit hour', async () => {
  const { declaration, projection } = await view();
  const ctx = context({ endLabels: true });
  const options = declaration.projectionOptions(ctx, { extent: [FIRST, HOUR], surface: '#111111' });
  const hoverHour = FIRST + 100;
  const { branchId, measure, decimals, lines, top, warnings } = reply(HOUR, { guns: 50, rifles: 900, tanks: null }, { keys: ['rifles', 'tanks'], refused: null });
  const head = { branchId, measure, decimals, lines, top, warnings };
  const readView = createBoundedReadView({
    hour: HOUR,
    series: new Map([['stock', new Map([['rifles', boundTiledSeries(tiled('rifles', 900), displayedHour(HOUR), { headValue: knownValue(900) })]])]]),
    panels: new Map([['lines', head]]),
    hovers: new Map([['hover', { hour: hoverHour, data: reply(hoverHour, { guns: 70, rifles: 400, tanks: 3 }, null) }]]),
  });
  const model = projection.project(readView, options);
  assert.deepEqual(model.series.map(series => series.key), ['rifles', 'tanks']);
  assert.equal(model.series[0]!.name, 'Infantry equipment');
  assert.equal(model.series[0]!.endLabel?.value, '900');
  const confirmed = projection.project(createBoundedReadView({ hour: HOUR + 1, panels: new Map([['lines', head]]) }), options);
  assert.equal(confirmed.series[0]!.headHour, HOUR + 1);
  assert.equal(confirmed.series[0]!.headValue, model.series[0]!.headValue);
  assert.equal(model.series[1]!.name, 'tanks');
  assert.equal(model.series[1]!.headValue, null);
  assert.equal(model.series[1]!.absentReason, 'The stockpile was not read at this hour.');
  assert.equal(model.series[1]!.endLabel, null);
  assert.notEqual(model.series[0]!.color, model.series[1]!.color);
  const hover = model.hoverDetail!;
  assert.equal(hover.hour, hoverHour);
  assert.deepEqual(hover.items.slice(1).map(item => [item.label, item.value]), [['Infantry equipment', '400'], ['tanks', '3']]);
  assert.deepEqual(model.auditRows?.map(row => row.value), ['900', 'The stockpile was not read at this hour.']);
});

test('a refused ranking draws no types and says why; the settings reach the axis and legend', async () => {
  const { declaration, projection } = await view();
  const refused = 'The main types are not ranked: the stock of every type is needed.';
  const readView = createBoundedReadView({
    hour: HOUR,
    panels: new Map([['lines', reply(HOUR, { rifles: 900 }, { keys: [], refused })]]),
  });
  const automatic = projection.project(readView, declaration.projectionOptions(context({}), { extent: [FIRST, HOUR], surface: '#111111' }));
  assert.equal(automatic.series.length, 0);
  assert.equal(automatic.empty?.detail, refused);
  const set = declaration.projectionOptions(context({ chosen: setToken('rifles'), measure: 'share', endLabels: false, yMin: -50, log: false }), { extent: [FIRST, HOUR], surface: '#111111' });
  const chosen = projection.project(readView, set);
  assert.deepEqual(chosen.series.map(series => series.key), ['rifles']);
  assert.equal(chosen.yAxis.format, 'percent');
  assert.equal(chosen.yAxis.min, -50);
  assert.deepEqual(chosen.legend?.map(entry => entry.label), ['Infantry equipment']);
  assert.equal(chosen.series[0]!.endLabel, null);
});

test('stockpile history loads keyed tiles for the followed type roster', async () => {
  const { declaration, projection } = await view();
  const ctx = context({});
  const viewport = { from: HOUR - 12, to: HOUR + 48, end: HOUR + 48, width: 100 };
  const entry = declaration.sources(ctx, { width: 100, height: 120 } as never).entries.find(entry => entry.name === 'stock')!;
  assert.equal(entry.read.shape, 'pixel-binned');
  if (entry.read.shape !== 'pixel-binned') return;
  const requests: { top?: number; countries?: string[] }[] = [];
  const client = {
    product: async (request: ProductRequest) => {
      const params = request.params as { top?: number; countries?: string[]; binHours: number; index: number };
      requests.push(params);
      const tags = params.countries ?? [];
      const firstHour = params.index * TILE_BINS * params.binHours;
      return { ...request, data: {
        branchId: '7', measure: 'stock', decimals: 5, binHours: params.binHours, index: params.index, firstHour,
        immutable: true, filled: firstHour + TILE_BINS * params.binHours - 1, rawValues: true, hourBytes: 0,
        lines: tags.map(country => ({ country, missing: [], parts: [] })), bins: new Uint8Array(tags.length * TILE_BINS),
      } };
    },
  } as never;
  const lane = chartTileLane(client, { ...entry, read: entry.read }, ctx.branch.lastHour, ctx.gateSpan, hour => hour as GatedHour);
  assert.ok(lane);
  const tiles = new TileView(new TileCache(), lane, () => {});
  tiles.setView(viewport);
  const options = declaration.projectionOptions(ctx, { extent: [FIRST, HOUR + 48], surface: '#111111' });
  for (const [i, keys] of [['mod#tanks', 'rifles'], ['rifles', 'mod#tanks'], ['rifles', 'radio'], [], []].entries()) {
    const hour = HOUR + i * 12;
    const refused = i === 4 ? 'Stockpile rank was not recorded' : null;
    const head = reply(hour, {}, { keys, refused });
    const readView = createBoundedReadView({ hour, panels: new Map([['lines', head]]) });
    const rank = projection.project(readView, options).followedTileRanks?.lines;
    assert.deepEqual(rank, { tags: keys, refused });
    tiles.setHour(hour, true);
    tiles.setFollowedRank(hour, { ...rank!, hour, from: hour, until: head.nextChange! - 1 });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(tiles.settled, true);
    assert.ok(tiles.current);
    assert.deepEqual(new Set(tiles.current.keys()), new Set(keys));
  }
  assert.equal(requests.filter(request => request.top !== undefined).length, 0);
  assert.deepEqual(requests.map(request => request.countries), [['mod#tanks', 'rifles'], ['radio']]);
  tiles.close();
});

test('the exact audit reads the dated main types, so a correct picture has an exact read to agree with', async () => {
  const { declaration, projection } = await view();
  const asked: string[] = [];
  const client = { product: async (request: { product?: string; params?: { product?: string } }) => {
    asked.push(JSON.stringify(request).includes('equipment-stockpile-lines') ? 'equipment-stockpile-lines' : 'other');
    return { data: reply(HOUR, { rifles: 1000, tanks: 20 }, { keys: ['rifles', 'tanks'], refused: null }) };
  } } as never;
  const plan = declaration.sources(context({}), { width: 600, height: 300 } as never);
  const exact = await readPlanExact(plan, HOUR, { client, following: false, timeMode: 'pin', branch: { firstHour: FIRST, lastHour: FIRST + 1000 },
    window: null, staticSpan: null, gate: { recorded: (h: number) => h, span: (a: number, b: number) => ({ firstHour: a, lastHour: b }) } as never });
  assert.ok(exact, 'an exact read exists');
  assert.deepEqual(asked, ['equipment-stockpile-lines']);
  const options = declaration.projectionOptions(context({}), { extent: [FIRST, HOUR], surface: '#111111' });
  assert.deepEqual(projection.project(exact, options).auditRows?.map(row => row.value), ['1K', '20']);
});
