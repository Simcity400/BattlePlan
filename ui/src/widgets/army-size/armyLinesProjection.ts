import { createCountryLinesView } from '../../families/time-chart/countryLines.ts';
import { MEASURES, armyMeasure, armyMetadataParams, validateArmyMetadata, type ArmyMetadataReply } from './armySizeMeta.ts';

const SERIES_MEASURES = { manpower: 'Manpower', divisions: 'Divisions', strength: 'Strength', battalions: 'Battalions' } as const;

export const { projection: armyLinesProjection, declaration: armyLinesDeclaration } = createCountryLinesView<ArmyMetadataReply>({
  kind: 'army-size',
  view: 'lines',
  title: 'Army size',
  subject: 'army size',
  format: 'compact',
  slotBackedRank: true,
  aux: {
    product: 'army-size',
    label: 'the army types',
    params: track => ({ ...armyMetadataParams(track.branch.id) }),
    validate: validateArmyMetadata,
  },
  measure: (options, aux) => {
    if (!aux) return null;
    if (!aux.available) return { unavailable: aux.missing[0]?.reason ?? 'Army totals are not recorded.' };
    const asked = typeof options.measure === 'string' && options.measure !== '' ? options.measure : null;
    if (asked !== null && !aux.measures.some(item => item === asked)) {
      const label = MEASURES.find(item => item.value === asked)?.label ?? asked;
      return { unavailable: `${label} is not recorded in this recording.` };
    }
    const measure = armyMeasure(options.measure, aux.measures);
    const owner = options.countFor === 'host' ? 'host' : 'owner';
    return { kind: 'army-totals', measure: `${owner}${SERIES_MEASURES[measure]}`, decimals: measure === 'strength' ? 5 : 0 };
  },
});
