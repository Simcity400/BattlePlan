import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProductRequest } from '../../dashboard/client.ts';
import { countryKey } from '../../dashboard/countryKey.ts';
import { message } from '../../dashboard/follow/messages.fixture.ts';
import type { GatedHour } from '../../dashboard/regionTime.ts';
import { TileCache } from '../../dashboard/tiles/cache.ts';
import { TILE_BINS } from '../../dashboard/tiles/tile.ts';
import { TileView, type TileRoster } from '../../dashboard/tiles/view.ts';
import { createBoundedReadView, displayedHour } from '../../families/boundedView.ts';
import { chartTileLane } from '../../families/host/tiledState.ts';
import type { FamilyPlanContext } from '../../families/plan.ts';
import { parseFollowed } from '../../test-support/followMessage.ts';
import { factoriesLinesDeclaration, factoriesLinesProjection } from './factoriesLinesProjection.ts';

test('played factory history uses the followed ranking and asks only for missing keyed tiles', async () => {
  const branch = { id: '1', firstHour: 100, lastHour: 600, gaps: [] };
  const ctx = {
    track: { source: { id: 's1', revision: 'r1' }, axisOffset: 0 }, branch, following: true,
    options: {}, countries: { top: 2, all: false, tags: [], holders: null, membership: null },
  } as unknown as FamilyPlanContext;
  const plan = factoriesLinesDeclaration.sources(ctx, { following: true, staticSpan: null });
  const entry = plan.entries.find(entry => entry.name === 'main')!;
  assert.ok(entry.read.shape === 'pixel-binned');
  assert.equal(entry.read.exactProduct, 'series-rank');

  const requests: { countries?: number[]; top?: number; hour?: number }[] = [];
  const client = {
    product: async (request: ProductRequest) => {
      const params = request.params as { countries?: number[]; top?: number; hour?: number; binHours: number; index: number };
      requests.push(params);
      const countries = params.countries ?? [7, 8];
      const firstHour = params.index * TILE_BINS * params.binHours;
      return { ...request, data: {
        branchId: '1', measure: 'free7', decimals: 0, binHours: params.binHours, index: params.index, firstHour,
        immutable: true, filled: firstHour + TILE_BINS * params.binHours - 1, rawValues: true, hourBytes: 0,
        ...(params.hour === undefined ? {} : { ranking: { hour: params.hour, from: params.hour, until: params.hour, refused: null } }),
        lines: countries.map(country => ({ country, missing: [], parts: [] })), bins: new Uint8Array(countries.length * TILE_BINS),
      } };
    },
  } as never;
  const lane = chartTileLane(client, { ...entry, read: entry.read }, branch.lastHour, () => null, hour => hour as GatedHour);
  assert.ok(lane);
  const tiles = new TileView(new TileCache(), lane, () => {});
  const rankSource = tiles.rankSource;
  assert.equal(rankSource, 'main');
  tiles.setView({ from: 290, to: 345, end: 345, width: 100 });
  const options = factoriesLinesDeclaration.projectionOptions(ctx, { extent: [100, 600], surface: '#111111' });
  const nameBySlot = new Map([[7, 'GER'], [8, 'FRA'], [9, 'ITA']]);

  for (const [index, countries] of [[7, 8], [8, 7], [8, 9], [], [], []].entries()) {
    const hour = 300 + 10 * index;
    const refused = index >= 4 ? 'Factories were not recorded for a contender' : null;
    const tags = countries.map(countryKey);
    const answer = parseFollowed(message(hour, [{ id: 1, answer: refused
      ? { notRecorded: refused }
      : { keys: countries.map(BigInt), columns: 1, values: countries.map((_, row) => BigInt(10 - row)), names: countries.map(slot => nameBySlot.get(slot)!) },
    }])).answers[0]!.answer;
    const view = createBoundedReadView(index === 5
      ? { hour: displayedHour(hour), refused: new Map([['main', refused!]]) }
      : { hour: displayedHour(hour), answers: new Map([['main', answer]]) });
    const model = factoriesLinesProjection.project(view, options);
    const rank: TileRoster | undefined = model.followedTileRanks?.[rankSource];
    assert.deepEqual(rank, { tags, refused });
    assert.deepEqual(model.series.map(series => series.key), tags);
    tiles.setHour(hour, true);
    tiles.setFollowedRank(hour, { ...rank!, hour, from: hour, until: hour });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(tiles.settled, true);
    assert.ok(tiles.current);
    assert.deepEqual([...tiles.current.keys()], tags);
  }
  assert.equal(requests.filter(request => request.hour !== undefined).length, 0);
  assert.deepEqual(requests.map(request => request.countries), [[7, 8], [9]]);
  tiles.setHour(350, false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(requests.filter(request => request.hour !== undefined).map(({ top, hour }) => ({ top, hour })), [{ top: 2, hour: 350 }]);
  tiles.close();
});
