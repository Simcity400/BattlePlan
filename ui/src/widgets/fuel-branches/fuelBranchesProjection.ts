import { dayLabel } from '../../charts/draw.ts';
import { colour } from '../../charts/palette.ts';
import { countryFromKey } from '../../dashboard/countryKey.ts';
import { artTooltipItem } from '../../families/art/adapters.ts';
import { unavailableArt, type ArtResult } from '../../families/art/types.ts';
import type { BarsWidgetDeclaration } from '../../families/bars/declaration.ts';
import type { BarsDataRow, BarsModel, BarsProjection, BarsRowMedia } from '../../families/bars/model.ts';
import type { BoundedReadView, FamilyPlanContext, SourcePlan } from '../../families/contract.ts';
import type { TooltipListItem } from '../../families/host/tooltips.ts';
import { registerFamilyProjection } from '../../families/registry.ts';
import { knownValue, notRecorded, zeroValue } from '../../families/value.ts';
import type { ValueFormat } from '../../families/valueFormat.ts';
import type { FuelBranchesReply, FuelConsumerRow } from '../../generated/dashboard';
import { FUEL_BRANCHES, FUEL_PLACES, branchName, fuelAmount, fuelDecimals, validateFuelBranches } from './fuelBranchesData.ts';

export interface FuelBranchesOptions {
  readonly digits: number;
  readonly surface: string;
}

const NO_BRANCH_ICON = 'The installed interface has no insignia icon for this branch';
const NO_FUEL_ICON = 'The installed interface has no fuel icon';

function resolveUrlArt(readView: BoundedReadView, url: string | null | undefined, reason: string | null | undefined, fallbackReason: string): ArtResult {
  if (url) return readView.art({ kind: 'url', url });
  return unavailableArt(reason ?? fallbackReason);
}

function branchRow(
  readView: BoundedReadView,
  reply: FuelBranchesReply,
  consumer: FuelConsumerRow,
  digits: number,
  fuelIcon: ArtResult,
  surface: string,
): BarsDataRow {
  const requestedRaw = BigInt(consumer.requested);
  const receivedRaw = BigInt(consumer.received);
  const unmetRaw = requestedRaw > receivedRaw ? requestedRaw - receivedRaw : 0n;
  const deliveredRaw = receivedRaw < requestedRaw ? receivedRaw : requestedRaw;
  const requestedNum = Number(requestedRaw) / reply.scale;
  const deliveredNum = Number(deliveredRaw) / reply.scale;
  const unmetNum = Number(unmetRaw) / reply.scale;
  const rawName = reply.consumerNames[consumer.index] ?? null;
  const named = rawName !== null && rawName.trim().length > 0 ? rawName : null;
  const label = branchName(reply.consumerNames, consumer.index);
  const iconUrl = reply.consumerIcons[consumer.index] ?? null;
  const iconReason = reply.consumerIconReasons[consumer.index] ?? null;
  const branchArt = resolveUrlArt(readView, iconUrl, iconReason, NO_BRANCH_ICON);
  const media: BarsRowMedia = { kind: 'art', art: branchArt, resolvedName: label };
  const format: ValueFormat = { decimals: FUEL_PLACES, maxDecimals: digits };

  const receivedText = fuelAmount(receivedRaw, digits);
  const requestedText = fuelAmount(requestedRaw, digits);
  const unmetText = fuelAmount(unmetRaw, digits);

  const items: TooltipListItem[] = [
    { label: 'Requested', value: `${requestedText} a day` },
    { label: 'Received', value: `${receivedText} a day` },
  ];
  if (unmetRaw > 0n) {
    items.push({ label: 'Unmet', value: `−${unmetText} a day`, tone: 'negative' });
  }
  items.push({ label: 'Priority', value: String(consumer.priority) });
  if (reply.readHour !== null) {
    items.push({ label: 'As of', value: dayLabel(reply.readHour), tone: 'muted' });
  }
  if (requestedRaw === 0n) {
    items.push({ label: 'No fuel requested', tone: 'muted' });
  }
  const branchArtTip = artTooltipItem('Branch icon', branchArt);
  if (branchArtTip) items.push(branchArtTip);
  const fuelArtTip = artTooltipItem('Fuel icon', fuelIcon);
  if (fuelArtTip) items.push(fuelArtTip);

  const zero = requestedRaw === 0n;
  return {
    kind: 'data',
    key: String(consumer.index),
    subject: String(consumer.index),
    label: named === null ? notRecorded('Branch name not recorded') : knownValue(named),
    media,
    color: colour(surface, consumer.index),
    value: {
      value: zero ? zeroValue(0n) : knownValue(receivedRaw),
      format,
      unit: 'a day',
    },
    numeric: zero ? 0 : deliveredNum,
    ...(zero ? {} : {
      target: {
        numeric: requestedNum,
        value: knownValue(requestedRaw),
        format,
        ...(unmetRaw > 0n ? { shortfall: knownValue(unmetRaw), shortfallNumeric: unmetNum } : {}),
      },
    }),
    readout: {
      icon: fuelIcon,
      iconLabel: 'Fuel',
      primary: zero ? '0' : receivedText,
      secondary: zero ? '/ 0 a day' : `/ ${requestedText} a day`,
      tone: zero ? 'muted' : 'default',
      ...(unmetRaw > 0n ? { shortfall: `−${unmetText}` } : {}),
    },
    tooltip: {
      title: label,
      subtitle: dayLabel(readView.hour),
      items,
    },
  };
}

function project(readView: BoundedReadView, options: FuelBranchesOptions): BarsModel {
  const base = { form: 'ordered' as const, showAxis: false, hour: readView.hour };
  const refused = readView.refused('main');
  if (refused) return { ...base, rows: [], empty: refused, emptyKind: 'unavailable' };
  const panel = readView.panel('main');
  if (panel === undefined) return { ...base, rows: [] };
  const reply = validateFuelBranches(panel);
  if (reply.missing !== null) {
    return { ...base, rows: [], empty: reply.missing, emptyKind: 'unavailable', warnings: reply.warnings };
  }
  if (!reply.consumers.length) {
    return { ...base, rows: [], empty: 'No fuel requested at this date.', emptyKind: 'empty', warnings: reply.warnings };
  }
  const fuelIcon = resolveUrlArt(readView, reply.fuelIcon, reply.fuelIconReason, NO_FUEL_ICON);
  const rows = reply.consumers.map(consumer => branchRow(readView, reply, consumer, options.digits, fuelIcon, options.surface));
  return {
    ...base,
    rows,
    warnings: reply.warnings,
  };
}

export const fuelBranchesProjection: BarsProjection<FuelBranchesOptions> = registerFamilyProjection({
  kind: 'fuel-branches',
  family: 'bars',
  singleValueBars: () => 'target-markers',
  nextChange: () => Infinity,
  project,
}, 'bars');

export function fuelBranchesSources(ctx: FamilyPlanContext): SourcePlan {
  const subject = ctx.countrySubject;
  const owner = `fuel-branches:${ctx.track.source.id}:${ctx.track.source.revision}:${ctx.branch.id}:${subject ?? ''}`;
  if (!subject) return { owner, entries: [] };
  const params = { branchId: ctx.branch.id, country: countryFromKey(subject) };
  return {
    owner,
    entries: [{
      name: 'main',
      source: ctx.track.source,
      branch: ctx.branch.id,
      offset: ctx.track.axisOffset,
      read: {
        shape: 'point',
        channel: 'panel',
        coverage: { mode: 'population', form: 'all' },
        product: FUEL_BRANCHES,
        followQuery: { panel: FUEL_BRANCHES, ...params },
        params,
        validate: validateFuelBranches,
      },
    }],
  };
}

export const fuelBranchesDeclaration: BarsWidgetDeclaration<FuelBranchesOptions> = {
  family: 'bars',
  kind: 'fuel-branches',
  label: 'Fuel by branch',
  subject: 'fuel by branch',
  emptyCampaign: 'Load a campaign to see fuel.',
  icon: 'droplet',
  countries: { mode: 'single', choose: 'Choose a country to see its fuel by branch.' },
  sources: fuelBranchesSources,
  projection: fuelBranchesProjection,
  projectionOptions: (ctx, extra) => ({ digits: fuelDecimals(ctx.options), surface: extra.surface }),
  jumpToDate: true,
  keyByBranch: true,
};
