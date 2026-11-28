import { createCountryLinesView } from '../../families/time-chart/countryLines.ts';
import { airForceTotals } from './airForceData.ts';

export const { projection: airForceLinesProjection, declaration: airForceLinesDeclaration } = createCountryLinesView({
  kind: 'air-force-size',
  view: 'lines',
  title: 'Air force size',
  subject: 'air force size',
  format: 'number',
  slotBackedRank: true,
  measure: options => airForceTotals(options),
});
