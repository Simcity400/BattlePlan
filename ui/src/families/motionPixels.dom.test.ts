import assert from 'node:assert/strict';
import test from 'node:test';
import { withNativePage } from '../../../tools/native-page.ts';

async function motionBrowser(url: string) {
  const { cdpSession } = await import(new URL('../../../tools/e2e/cdp.mjs', import.meta.url).href) as {
    cdpSession(url: string): Promise<{ send(method: string, params: Record<string, unknown>): Promise<unknown>; close(): void }>;
  };
  const cdp = await cdpSession(url);
  try {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    return cdp;
  } catch (error) {
    cdp.close();
    throw error;
  }
}

test('ordered bars settle to the same pixels as a cold draw after worker playback', async () => {
  await withNativePage('ordered-bars-pixel-settle', '/ui/src/families/motionPixels.dom.fixture.ts', async page => {
    for (const withTarget of [false, true]) {
      const { results, tinyEndpoints, histories, afterScroll, afterResize, afterTick, afterRefusal } = await page.evaluate<{
        results: { dpr: number; moving: number; paused: number }[];
        tinyEndpoints: { dpr: number; first: number; last: number }[];
        histories: { revoked: boolean; history: string; difference: number }[];
        afterScroll: number; afterResize: number; afterTick: number; afterRefusal: number;
      }>(`window.checkSettledPixels(${withTarget})`);
      for (const result of results) {
        const detail = `DPR ${result.dpr}, with target ${withTarget}`;
        assert.ok(result.moving > 0, `no movement at ${detail}`);
        assert.equal(result.paused, 0, `paused picture differs at ${detail}`);
      }
      if (withTarget) assert.equal(tinyEndpoints.length, 8);
      for (const { dpr, first, last } of tinyEndpoints) assert.deepEqual([first, last], [0, 0], `tiny target endpoints at DPR ${dpr}`);
      for (const sample of histories) assert.equal(sample.difference, 0, `${sample.history} with endpoint refusal ${sample.revoked}`);
      assert.equal(afterScroll, 0, 'layout must not copy other pixels into the owned slot');
      assert.equal(afterResize, 0, 'the worker redraws owned pixels as the resized geometry takes effect');
      assert.equal(afterTick, 0, 'the next tick at the same clock hour draws identical pixels');
      assert.equal(afterRefusal, 0, 'a proven unavailable hour matches its recorded cold picture');
    }
  });
});

test('the shared host shows a proven refusal and reveals the held recorded bar after it expires', async () => {
  await withNativePage('ordered-bars-host-refusal', '/ui/src/families/motionHost.dom.fixture.tsx', async page => {
    const cdp = await motionBrowser(page.page);
    try {
      const result = await page.evaluate('window.checkHostedRefusal()');
      assert.deepEqual(result, { through: 100, painted: 100, rebound: true, resumed: true });
    } finally { cdp.close(); }
  });
});

test('a stationary pointer loses its tooltip on a painted row swap and recovers on installation', async () => {
  await withNativePage('ordered-bars-host-hover', '/ui/src/families/motionHost.dom.fixture.tsx', async page => {
    const cdp = await motionBrowser(page.page);
    try {
      const point = await page.evaluate<{ x: number; y: number }>('window.mountHostedHover()');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      const result = await page.evaluate<{ before: string; behind: number; closed: boolean; replaced: boolean; after: string; installed: number }>('window.checkHostedHover()');
      assert.equal(result.before, 'GER');
      assert.equal(result.behind, 100);
      assert.equal(result.closed, true, 'the Germany tooltip closes before the newer rows install');
      assert.equal(result.installed, 101);
      assert.equal(result.replaced, true, 'the same pointer opens the new row tooltip with its recorded value');
      assert.equal(result.after, 'FRA');
    } finally { cdp.close(); }
  });
});
