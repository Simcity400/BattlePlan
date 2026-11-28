import {
  measureOf,
  ruleOf,
  territoryMeasureLabel,
  territoryNote,
  territorySeriesMeasure,
} from '../../dashboard/territoryMeasure.ts';
import { isFactionTotalsSelection } from '../../families/bars/factionTotalsRace.ts';
import type { BoundedReadView, FamilyPlanContext, SourcePlan } from '../../families/contract.ts';
import { registerFamilyProjection } from '../../families/registry.ts';
import { buildCountryLinesView, type CountryLinesOptions } from '../../families/time-chart/countryLines.ts';
import type { TimeChartProjection, TimeChartWidgetDeclaration } from '../../families/time-chart/declaration.ts';
import {
  factionTotalsLinesOptions,
  factionTotalsLinesSources,
  projectFactionTotalsLines,
  type FactionTotalsLinesOptions,
} from '../../families/time-chart/factionTotalsLines.ts';

export interface TerritoryLinesOptions {
  readonly mode: 'countries' | 'factions';
  readonly measureLabel: string;
  readonly note?: string;
  readonly countries: CountryLinesOptions;
  readonly factions: FactionTotalsLinesOptions;
}

const countryView = buildCountryLinesView({
  kind: 'territory',
  view: 'lines',
  title: 'Territory',
  subject: 'territory',
  format: 'number',
  step: true,
  slotBackedRank: true,
  digits: () => 0,
  measure: options => ({
    kind: 'territory',
    measure: territorySeriesMeasure(measureOf(options.measure), ruleOf(options.rule)),
    decimals: 0,
  }),
});

export const territoryLinesProjection: TimeChartProjection<TerritoryLinesOptions> = registerFamilyProjection({
  kind: 'territory',
  family: 'time-chart',
  variant: 'line',
  joinMode: 'step',
  measureTitle: 'Territory',
  project(readView: BoundedReadView, options: TerritoryLinesOptions) {
    if (options.mode === 'factions') {
      return projectFactionTotalsLines(readView, options.factions);
    }
    const base = countryView.projection.project(readView, options.countries);
    return {
      ...base,
      measureTitle: options.measureLabel,
      ...(options.note ? { summaryText: options.note } : {}),
    };
  },
}, 'lines');

function territoryLinesSources(ctx: FamilyPlanContext, opts: Parameters<typeof countryView.declaration.sources>[1]): SourcePlan {
  const measure = measureOf(ctx.options.measure);
  const rule = ruleOf(ctx.options.rule);
  const seriesMeasure = territorySeriesMeasure(measure, rule);
  const plan = isFactionTotalsSelection(ctx.widget.countries)
    ? factionTotalsLinesSources('territory:lines', ctx, 'territory', seriesMeasure)
    : countryView.declaration.sources(ctx, opts);
  return plan.entries.length ? plan : { ...plan, refused: ctx.countries.reason ?? 'No territory is available for this selection.' };
}

export const territoryLinesDeclaration: TimeChartWidgetDeclaration<TerritoryLinesOptions> = {
  family: 'time-chart',
  kind: 'territory',
  label: 'Territory',
  subject: 'territory',
  emptyCampaign: 'Load a campaign to see its territory.',
  icon: 'map',
  countries: {
    mode: 'multi',
    content: 'history',
    allowSlots: true,
    everyOnTop: true,
    factions: true,
    requireGroupsWhen: widget => widget.countries.kind === 'factions'
      || (widget.countries.kind === 'group' && widget.countries.group.type !== 'top'),
  },
  sources: territoryLinesSources,
  projection: territoryLinesProjection,
  projectionOptions(ctx, extra) {
    const measure = measureOf(ctx.options.measure);
    const rule = ruleOf(ctx.options.rule);
    const seriesMeasure = territorySeriesMeasure(measure, rule);
    const measureLabel = territoryMeasureLabel(measure, rule);
    const note = territoryNote(measure);
    const useFactions = isFactionTotalsSelection(ctx.widget.countries);
    return {
      mode: useFactions ? 'factions' : 'countries',
      measureLabel,
      ...(note ? { note } : {}),
      countries: countryView.declaration.projectionOptions(ctx, extra),
      factions: factionTotalsLinesOptions(
        'territory',
        ctx,
        { seriesKind: 'territory', measure: seriesMeasure, measureLabel, ...(note ? { note } : {}) },
        extra,
      ),
    };
  },
  unavailable: ctx => {
    if (ctx.widget.countries.kind === 'factions') return null;
    return ctx.countries.reason;
  },
};

export function territoryLinesDeclarationWithStyles(
  styles: FactionTotalsLinesOptions['styles'],
  shared: FactionTotalsLinesOptions['shared'],
  identities?: FactionTotalsLinesOptions['identities'],
): TimeChartWidgetDeclaration<TerritoryLinesOptions> {
  return {
    ...territoryLinesDeclaration,
    projectionOptions: (ctx, extra) => {
      const base = territoryLinesDeclaration.projectionOptions(ctx, extra);
      return { ...base, factions: { ...base.factions, styles, shared, ...(identities ? { identities } : {}) } };
    },
  };
}
