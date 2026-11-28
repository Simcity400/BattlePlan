import type { FamilyPlanContext } from '../plan.ts';
import type { FamilyHostAdapter, FamilyRowWindow, FamilySettingsPolicy, ParsedFamilyHit } from '../host/adapter.ts';
import { sameFieldValue } from '../laneRuntime.ts';
import type { AnyTableWidgetDeclaration } from './declaration.ts';
import type { FamilyTableBinding } from './laneView.ts';
import { buildColumnLayouts, extentsRowWindow, selectVisibleColumns, type RowExtents, type TableRhythm } from './layout.ts';
import { deriveTableAudit, resolveTableRows, tableRank, type TableColumnSpec, type TableModel } from './model.ts';
import { combinedPaneRows, resolvePanes } from './panes.ts';
import { displayWindowToData } from './rowSource.ts';
import { SubjectFigures } from './subjectFigures.ts';
import { encodeTableSettings, MEDIA_ROW_HEIGHT, ROW_HEIGHT, TABLE_SETTINGS_KEY, tableSettingsOf, type TableSettings } from './settings.ts';

interface TableWidthsField {
  readonly narrowed?: boolean;
  readonly totalWidth: number;
}

interface TableInfoField {
  readonly count: number;
  readonly totalHeight: number;
  readonly gapBefore?: readonly number[];
  readonly extents?: RowExtents;
}

export interface TableChromeState {
  readonly meta: ChromeMeta;
  readonly widths?: ChromeWidths;
  readonly panes: unknown;
  readonly figures: SubjectFigures;
}

interface ChromeWidths {
  readonly widths: Readonly<Record<string, number>>;
  readonly visible: readonly string[];
  readonly totals?: readonly string[];
  readonly scrollable: boolean;
  readonly pinnedCount?: number;
}

function chromeWidths(raw: unknown): ChromeWidths | undefined {
  if (!raw) return undefined;
  const { widths, visible, totals, scrollable, pinnedCount } = raw as ChromeWidths;
  return { widths, visible, totals, scrollable, pinnedCount };
}

interface ChromeMeta {
  readonly subjectSummary?: TableModel['subjectSummary'];
  readonly kindFilter?: TableModel['kindFilter'];
  readonly hideHeader?: boolean;
  readonly searchable?: boolean;
  readonly search?: string;
  readonly rhythm?: TableRhythm;
  readonly unsorted?: boolean;
  readonly rankShown?: boolean;
  readonly rankWidth?: number;
  readonly hasTree?: boolean;
  readonly columns?: readonly TableColumnSpec[];
}

const NO_CHROME_META: ChromeMeta = {};
const chromeByMeta = new WeakMap<object, ChromeMeta>();

function chromeMeta(raw: unknown): ChromeMeta {
  if (!raw || typeof raw !== 'object') return NO_CHROME_META;
  const held = chromeByMeta.get(raw);
  if (held) return held;
  const { subjectSummary, kindFilter, hideHeader, searchable, search, rhythm, unsorted, rankShown, rankWidth, hasTree, columns } = raw as ChromeMeta;
  const chrome = { subjectSummary, kindFilter, hideHeader, searchable, search, rhythm, unsorted, rankShown, rankWidth, hasTree, columns };
  chromeByMeta.set(raw, chrome);
  return chrome;
}

function tableColumns(declaration: AnyTableWidgetDeclaration, ctx: FamilyPlanContext<unknown> | null): readonly TableColumnSpec[] {
  if (typeof declaration.columns !== 'function') return declaration.columns;
  return ctx ? declaration.columns(ctx) : [];
}

export function parseTableHit(hitKey: string | null): ParsedFamilyHit | null {
  if (!hitKey) return null;
  const toggle = hitKey.startsWith('toggle:');
  if (!toggle && !hitKey.startsWith('row:')) return null;
  const key = hitKey.slice(hitKey.indexOf(':') + 1);
  return key ? { key, toggle, inspectToken: `row:${key}` } : null;
}

export const tableSettingsPolicy: FamilySettingsPolicy<TableSettings> = {
  resolve: (raw, ctx, options) => {
    const declaration = raw as AnyTableWidgetDeclaration;
    const columns = tableColumns(declaration, ctx);
    const policy = declaration.settings;
    if (policy.kind === 'fixed') return tableSettingsOf(undefined, columns, policy.base);
    if (policy.kind === 'table') return tableSettingsOf(options[policy.key ?? TABLE_SETTINGS_KEY], columns, policy.base);
    return ctx
      ? policy.resolve(ctx, columns)
      : tableSettingsOf(undefined, columns, { density: 'normal', barsBehind: 'all', sort: { column: columns[0]?.key ?? '', direction: 'descending' } });
  },
  store: (raw, next, live, ctx, setOption) => {
    const policy = (raw as AnyTableWidgetDeclaration).settings;
    if (policy.kind === 'fixed') return;
    if (policy.kind === 'table') {
      setOption(policy.key ?? TABLE_SETTINGS_KEY, encodeTableSettings(next));
      return;
    }
    policy.onChange(next, live, { ...ctx, settings: live }, setOption);
  },
  editable: raw => (raw as AnyTableWidgetDeclaration).settings.kind !== 'fixed',
};

export const tableHostAdapter: FamilyHostAdapter<TableModel, unknown, FamilyTableBinding, TableSettings> = {
  family: 'table',
  skeleton: 'table',
  scroll: 'both',
  navigation: 'rows',
  mirror: 'table',
  mirrorFocus: 'rows',
  tree: true,
  settings: tableSettingsPolicy,
  chromeState: (fields, previous) => {
    const prev = previous as TableChromeState | undefined;
    const meta = chromeMeta(fields.meta);
    const widths = chromeWidths(fields.widths);
    if (prev && sameFieldValue(prev.widths, widths) && sameFieldValue(prev.panes, fields.panes)
      && (prev.meta.subjectSummary ? prev.figures.follow(meta) : sameFieldValue(prev.meta, meta))) return prev;
    return { meta, widths, panes: fields.panes, figures: new SubjectFigures(meta) };
  },
  parseHit: parseTableHit,
  getScrollExtent: fields => {
    const widths = fields.widths as TableWidthsField | undefined;
    const table = fields.table as TableInfoField | undefined;
    return {
      ...(widths ? { width: widths.totalWidth } : {}),
      ...(table ? { height: table.totalHeight } : {}),
    };
  },
  rowWindow: (viewport, settings, fields) => {
    if (!settings) return null;
    const media = (fields.meta as { readonly rowHeightMode?: string } | undefined)?.rowHeightMode === 'media';
    const table = fields.table as TableInfoField | undefined;
    const count = table?.count ?? Number.POSITIVE_INFINITY;
    const rowHeight = (media ? MEDIA_ROW_HEIGHT : ROW_HEIGHT)[settings.density];
    const extents = table?.extents?.rowHeight === rowHeight ? table.extents : null;
    const win = extentsRowWindow(count, extents, rowHeight, viewport.scrollTop, viewport.height);
    const gapBefore = table?.gapBefore;
    if (!gapBefore || gapBefore.length === 0) return win;
    const data = displayWindowToData(win, gapBefore, Number.isFinite(count) ? Math.max(0, count - gapBefore.length) : undefined);
    return { ...win, dataFirst: data.first, dataCount: data.count };
  },
  deriveAuditRows: (model, _hour, { settings, expanded, fields }) => {
    if (!settings) return [];
    const narrowed = (fields.widths as TableWidthsField | undefined)?.narrowed === true;
    const mode = model.rowHeightMode ?? 'standard';
    const panes = model.panes ? resolvePanes(model, settings, expanded, mode) : null;
    const flatRows = panes ? combinedPaneRows(panes) : resolveTableRows(model, settings, expanded);
    const { shown: rankShown } = tableRank(model, settings);
    const visibleColumns = selectVisibleColumns(buildColumnLayouts(model.columns, settings), narrowed);
    return deriveTableAudit({
      model,
      flatRows,
      visibleColumns,
      rankShown,
      ...(fields.range ? { window: fields.range as FamilyRowWindow } : {}),
    });
  },
  buildBinding: ctx => (ctx.settings
    ? {
        settings: ctx.settings,
        expanded: ctx.expanded,
        reducedMotion: ctx.reducedMotion,
      }
    : null),
};
