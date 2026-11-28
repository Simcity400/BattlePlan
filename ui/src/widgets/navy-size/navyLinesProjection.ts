import { createCountryLinesView } from '../../families/time-chart/countryLines.ts';
import { navyTotals } from './navyData.ts';

export const { projection: navyLinesProjection, declaration: navyLinesDeclaration } = createCountryLinesView({
  kind: 'navy-size',
  view: 'lines',
  title: 'Navy size',
  subject: 'navy size',
  format: 'number',
  slotBackedRank: true,
  measure: options => navyTotals(options),
});
