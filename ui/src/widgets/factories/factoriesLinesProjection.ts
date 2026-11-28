import { contentSet } from '../../dashboard/options.ts';
import { createCountryLinesView } from '../../families/time-chart/countryLines.ts';
import { countMode, factoryMeasure } from './factoriesData.ts';

export const { projection: factoriesLinesProjection, declaration: factoriesLinesDeclaration } = createCountryLinesView({
  kind: 'factories',
  view: 'lines',
  title: 'Factories',
  subject: 'factories',
  format: 'number',
  measure: options => ({ kind: 'country-factories', measure: factoryMeasure(countMode(options.count), contentSet(options.types)), decimals: 0 }),
});
