import { contentSet } from '../../dashboard/options.ts';
import type { TimeChartWidgetDeclaration } from '../../families/time-chart/declaration.ts';
import { registerFamilyProjection } from '../../families/registry.ts';
import { buildCountryLinesView, type CountryLinesOptions } from '../../families/time-chart/countryLines.ts';
import { rankedCountries } from '../../families/time-chart/seriesHelpers.ts';
import { countMode, factoryMeasure } from './factoriesData.ts';

const { projection, declaration } = buildCountryLinesView({
  kind: 'factories',
  view: 'lines',
  title: 'Factories',
  subject: 'factories',
  format: 'number',
  measure: options => ({ kind: 'country-factories', measure: factoryMeasure(countMode(options.count), contentSet(options.types)), decimals: 0 }),
});

export const factoriesLinesProjection = registerFamilyProjection({
  ...projection,
  project(readView, options) {
    const model = projection.project(readView, options);
    if (options.top === null) return model;
    const answer = readView.answer('main');
    const refused = readView.refused('main') ?? (answer?.kind === 'notRecorded' ? answer.reason : null);
    const rank = answer && !refused ? rankedCountries(readView, 'main') : null;
    if (!rank && !refused) return model;
    return { ...model, followedTileRanks: { main: { tags: rank ? [...rank.rows.keys()] : [], refused } } };
  },
}, 'lines');

export const factoriesLinesDeclaration: TimeChartWidgetDeclaration<CountryLinesOptions> = {
  ...declaration,
  projection: factoriesLinesProjection,
  sources(ctx, options) {
    const plan = declaration.sources(ctx, options);
    return {
      ...plan,
      entries: plan.entries.map(entry => entry.name === 'main' && entry.read.shape === 'pixel-binned' && entry.read.top
        ? { ...entry, read: { ...entry.read, followRank: 'main' } }
        : entry),
    };
  },
};
