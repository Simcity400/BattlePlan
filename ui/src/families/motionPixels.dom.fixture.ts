import { datedPanel, datedRecord } from '../dashboard/follow/messages.fixture.ts';
import type { Refusal } from '../dashboard/follow/page.ts';
import { Lane, type Presented } from '../draw/lane.ts';
import { DEFAULT_SEEDS, deriveColors } from '../shell/appearance/themes.ts';
import { defaultArtFrame, readyArt } from './art/types.ts';
import { barsLane, type FamilyBarsBinding } from './bars/laneView.ts';
import type { BarsModel } from './bars/model.ts';
import type { FamilyTheme } from './contract.ts';
import { createLaneView } from './laneRuntime.ts';
import { registerFamilyProjection } from './registry.ts';
import { knownValue } from './value.ts';

const colours = deriveColors(DEFAULT_SEEDS.dark);
const theme: FamilyTheme = {
  surface: colours.surface, raised: colours.raised, dark: true, text: colours.text, muted: colours.muted,
  line: colours.border, lineSoft: colours.border, accent: colours.accent, blue: colours.accent, red: colours.error,
  shortage: colours.error, amber: colours.warning, green: colours.positive, grey: colours.muted, hatch: colours.muted,
  hatchEdge: colours.border, font: 'Segoe UI, sans-serif', fontSize: { small: 11, body: 12 }, lineWidth: 1, hatchSpacing: 6,
};

function rig(kind: string, dpr: number, values = [30, 150]) {
  let now = 1000;
  let serial = 0;
  let presented: Presented<ImageBitmap> | undefined;
  const queued: (() => void)[] = [];
  const view = createLaneView(barsLane, () => {});
  const lane = new Lane<ImageBitmap>({
    lane: 0, lanes: 1, views: () => view, crop: async () => [], present: picture => { presented = picture; }, release() {},
    fail: reason => { throw new Error(reason); }, later: draw => queued.push(draw), clock: () => now,
  });
  const canvas = new OffscreenCanvas(1, 1);
  lane.setLaneSurface(canvas, true);
  lane.follow(1, 'panel', 'p');
  lane.bindRoute(1, 1, 9, 1, 0);
  lane.mount(1, [1], 'bars', {
    family: 'bars', kind, view: 'main', options: {}, sources: { main: 1 }, scrollTop: 0, width: 481, height: 235, theme,
  } satisfies FamilyBarsBinding);
  lane.bind(1, { generation: 1, pin: null, offset: 0, surfaces: [{ width: 481, height: 235, dpr }] });
  const layout = (width = 490, scrollLeft = 0, slotX = 3) => lane.setLaneSlots({
    width, height: 250, dpr, scrollLeft, scrollTop: 0, clipPathFallback: false, surfaceColor: theme.surface, cornerRadius: 9,
    slots: [{ widget: 1, x: slotX, y: 4, w: 481, h: 235, bx: slotX, by: 2, bw: 481, bh: 238, visible: true }],
  });
  layout();
  lane.receive('panels', datedPanel(1, 100, values[0]));
  lane.receive('panels', datedPanel(1, 101, values[1]));
  const request = async (now: number, speed = 0, acknowledge = false, refused: Refusal[] = []) => {
    const installed = acknowledge ? (presented?.entries ?? []).map(({ id, widget, binding }) => ({ id, widget, binding })) : [];
    lane.frame({ type: 'frame', serial: ++serial, now, target: now, exact: true, seek: 1, speed, installed, refused, inspect: [] });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const clock = (playing: boolean, position = 100, speed = playing ? 1 : 0) => lane.setClock({
    playing, speed, anchorPosition: position, anchorTimeMs: performance.timeOrigin + now, seek: 1, exactHour: Math.floor(position),
  });
  const step = (elapsed = 200) => {
    now += elapsed;
    for (const draw of queued.splice(0)) draw();
  };
  return {
    request, clock, step, layout,
    pixels: (x = 0, y = 0, w = canvas.width, h = canvas.height) => canvas.getContext('2d')!.getImageData(x, y, w, h).data,
    later: () => lane.receive('panels', datedPanel(1, 104, 185)),
    revoke: () => lane.receive('panels', datedRecord(1, 101, 0, 'Withdrawn')),
    lastEntry: () => presented?.entries.at(-1),
  };
}

function changedBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
  return changed;
}

async function checkSettledPixels(withTarget = false) {
  const sprite = new OffscreenCanvas(37, 21);
  const brush = sprite.getContext('2d')!;
  brush.fillStyle = theme.red;
  brush.fillRect(0, 0, 37, 21);
  brush.fillStyle = theme.text;
  brush.fillRect(9, 0, 23, 11);
  const bitmap = sprite.transferToImageBitmap();
  const flag = { ...readyArt('fixture-flag', { frame: defaultArtFrame(37, 21) }), bitmap };
  const kind = withTarget ? 'target-bars-pixel-settle' : 'ordered-bars-pixel-settle';
  registerFamilyProjection({
    family: 'bars', kind,
    singleValueBars: () => withTarget ? 'target-markers' : true,
    project(view): BarsModel {
      const refused = view.refused('main');
      if (refused) return { form: 'ordered', hour: view.hour, rows: [], empty: refused, emptyKind: 'unavailable' };
      const value = Number(view.panel('main'));
      const target = value <= 0.1 ? 0.1 : value + 40;
      return {
        form: 'ordered', hour: view.hour, scaleMax: 200, showAxis: true,
        rows: [{
          kind: 'data', key: 'fixture', label: knownValue('Fixture country'), numeric: value, value: { value: knownValue(value) },
          media: { kind: 'flag', art: flag, tag: 'FIX' },
          ...(withTarget ? {
            target: { numeric: target, value: knownValue(target) },
            readout: { primary: String(value), secondary: `/ ${target} a day` },
          } : {}),
        }],
      };
    },
  }, 'main');
  const results: { dpr: number; moving: number; paused: number }[] = [];
  const tinyEndpoints: { dpr: number; first: number; last: number }[] = [];
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const played = rig(kind, dpr);
    await played.request(100);
    const initial = played.pixels();
    played.clock(true);
    played.step();
    played.step();
    const moving = changedBytes(initial, played.pixels());
    played.clock(false);
    await played.request(100);
    played.step();
    const cold = rig(kind, dpr);
    await cold.request(100);
    results.push({ dpr, moving, paused: changedBytes(cold.pixels(), played.pixels()) });
    if (withTarget) for (const values of [[0.1, 0], [0, 0.1]]) {
      const live = rig(kind, dpr, values);
      const endpoint = rig(kind, dpr, values);
      live.clock(true);
      await live.request(100, 1);
      live.step(0);
      await endpoint.request(100);
      const first = changedBytes(endpoint.pixels(), live.pixels());
      live.step(500);
      live.step(500);
      await endpoint.request(101);
      const last = changedBytes(endpoint.pixels(), live.pixels());
      tinyEndpoints.push({ dpr, first, last });
    }
  }
  const histories = [];
  for (const revoked of [false, true]) {
    const cold = rig(kind, 1.25);
    if (revoked) cold.revoke();
    await cold.request(revoked ? 100 : 101);
    const expected = cold.pixels();
    for (const history of ['skip', 'midpoint', 'late-ack', 'speed-change'] as const) {
      const played = rig(kind, 1.25);
      played.clock(true);
      await played.request(100, 1);
      await played.request(100, 1, true);
      if (history !== 'skip') played.step(500);
      if (history === 'late-ack') await played.request(101, 1);
      if (revoked) played.revoke();
      if (history === 'late-ack') {
        const entry = played.lastEntry()!;
        await played.request(102, 1, !revoked, revoked ? [{ widget: 1, id: entry.id, reason: 'kept content' }] : []);
      }
      if (history === 'speed-change' && !revoked) {
        played.later();
        cold.later();
        played.clock(true, 104);
        played.step(0);
      }
      played.clock(true, 102, history === 'speed-change' ? 24 : 1);
      played.step(0);
      histories.push({ revoked, history, difference: changedBytes(expected, played.pixels()) });
    }
  }
  const geometry = rig(kind, 1);
  geometry.clock(true);
  await geometry.request(100, 1);
  geometry.step(500);
  const region = (x = 3) => geometry.pixels(x, 2, 481, 238);
  const moving = region();
  geometry.layout(490, 12);
  const afterScroll = changedBytes(moving, region());
  const positioned = rig(kind, 1);
  positioned.layout(525, 12, 14);
  positioned.clock(true);
  await positioned.request(100, 1);
  positioned.step(500);
  const expected = positioned.pixels(14, 2, 481, 238);
  geometry.layout(525, 12, 14);
  const afterResize = changedBytes(expected, region(14));
  geometry.step(0);
  const afterTick = changedBytes(expected, region(14));
  const refused = rig(kind, 1.25);
  refused.clock(true);
  await refused.request(100, 1);
  refused.step(500);
  refused.revoke();
  refused.clock(true, 101.5);
  refused.step(0);
  const coldRefusal = rig(kind, 1.25);
  coldRefusal.revoke();
  await coldRefusal.request(101);
  const afterRefusal = changedBytes(refused.pixels(), coldRefusal.pixels());
  bitmap.close();
  return { results, tinyEndpoints, histories, afterScroll, afterResize, afterTick, afterRefusal };
}

(window as unknown as { checkSettledPixels: typeof checkSettledPixels }).checkSettledPixels = checkSettledPixels;
