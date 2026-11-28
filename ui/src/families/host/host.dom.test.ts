import assert from 'node:assert/strict';
import test from 'node:test';
import { withNativePage } from '../../../../tools/native-page.ts';

test('shared family host handles F1 campaign switch pin clear, F2 leave-then-deactivate hover cleanup, F3/F4 theme & reduced motion, F5 press across frame update, F12 dual placement isolation + typeahead, points keyboard focus cancelling delayed pointer hover replies, and the generic FamilyHost doing no React render, bind or paint on quiet, steady and paused frames', async t => {
  await withNativePage('family-host', '/ui/src/families/host/host.dom.fixture.tsx', page => page.stage('family-host', async () => {
    const act = <T,>(expression: string) => page.evaluate<T>(`window.hostDom.${expression}`);
    const { cdpSession } = await import(new URL('../../../../tools/e2e/cdp.mjs', import.meta.url).href) as {
      cdpSession(url: string): Promise<{ send(method: string, params?: Record<string, unknown>): Promise<unknown>; close(): void }>;
    };
    const cdp = await cdpSession(page.page);
    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      const mounted = await act<{ pipeId: number }>('mountPrimary()');
      assert.ok(mounted.pipeId > 0);

      const f1 = await act<{ pinnedBefore: string | null; cleared: boolean }>('testF1PinClearsOnCampaignSwitch()');
      assert.equal(f1.pinnedBefore, 'Germany', 'F1: tooltip was pinned before campaign switch');
      assert.equal(f1.cleared, true, 'F1: switching campaign clears pinned tooltip even when host stays mounted');

      const box = await act<{ left: number; top: number }>('bodyBox()');
      const px = Math.round(box.left + 40);
      const py = Math.round(box.top + 14);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      const f2 = await act<{ tipVisible: boolean; clearedOnDeactivate: boolean }>('testF2LeaveThenDeactivateClearsHover()');
      assert.equal(f2.tipVisible, true, 'F2: hover tooltip appeared before leave');
      assert.equal(f2.clearedOnDeactivate, true, 'F2: deactivating before 100ms leave timer clears tooltip without stranding');

      const f3f4 = await act<{ unrelatedCommits: number; unrelatedBinds: number; bindsAfterToggle: number; boundReduced: boolean }>('testF3UnrelatedAppearanceAndF4ReducedMotion()');
      assert.equal(f3f4.unrelatedCommits, 0, 'F3: unrelated appearance event causes 0 React commits');
      assert.equal(f3f4.unrelatedBinds, 0, 'F3: unrelated appearance event causes 0 pipeline binds');
      assert.equal(f3f4.boundReduced, true, 'F4: toggling app reduced motion while paused updates binding immediately');
      assert.ok(f3f4.bindsAfterToggle > 0, 'F4: reduced motion change triggers rebind');

      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      assert.equal(await act<boolean>('waitInspected("GER")'), true, 'F5: GER inspected before press');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
      await act('testF5FrameUpdateDuringPress()');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
      const f5Activated = await act<string[]>('waitActivated()');
      assert.deepEqual(f5Activated, ['GER'], 'F5: updating widget frame mid-press preserves pointerdown and activates row on release');

      assert.equal(await act<boolean>('waitHoverRow("GER")'), true, 'the hovered row is reported');
      const reset = await act<{ before: string | null; cleared: string | null; afterInstall: string | null }>('testHoverRowOwnerReset()');
      assert.deepEqual([reset.before, reset.cleared, reset.afterInstall], ['GER', null, null], 'an owner reset clears the hovered row, and the first picture of the new owner reports none while the pointer rests');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px + 1, y: py });
      assert.equal(await act<boolean>('waitHoverRow("GER")'), true, 'the pointer hitting the row again reports it');

      const focus = await act<{ moved: (string | null)[]; playing: { hoursAdvanced: number; installs: number; repainted: boolean; calls: number; commits: number }; outside: (string | null)[]; left: (string | null)[] }>('testFocusRow()');
      assert.deepEqual(focus.moved, ['GER', 'FRA'], 'the focused row is reported each time keyboard focus moves to another row');
      assert.ok(focus.playing.hoursAdvanced > 0 && focus.playing.repainted, `playback advanced and installed another picture under the resting focus (${focus.playing.installs} installs)`);
      assert.deepEqual([focus.playing.calls, focus.playing.commits], [0, 0], `while playback runs under a resting focus: no report and no React render (${focus.playing.hoursAdvanced} hours)`);
      assert.deepEqual(focus.outside, [null], 'a seek that takes the picture away clears the focused row with it');
      assert.deepEqual(focus.left, [null], 'focus leaving the rows clears the focused row');

      type VisibleTip = { open: boolean; title: string | null; subtitle: string | null; pinned: string | null; rows: Array<[string, string]> };
      type PointsMount = {
        pipeId: number;
        hour12Point: { x: number; y: number };
        navKeys: string[];
        initialTooltip: VisibleTip;
        date0: string;
        date3: string;
        date6: string;
        date24: string;
      };
      type DeliveredState = {
        visibleTooltip: VisibleTip;
        inspecting: string | null;
        hoverHours: Array<number | null>;
        navRequests: Array<{ key: string; currentHour: number | null }>;
      };

      const pressPinKey = async () => {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', text: 'p', unmodifiedText: 'p', windowsVirtualKeyCode: 80 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
      };

      const queueHour12Hover = async (x: number, y: number, label: string) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        const held = await act<{ count: number; key: string | null }>('waitHeldPointsHit()');
        assert.equal(held.count, 1, `${label}: pointer hover hit reply is held pending`);
        assert.match(held.key ?? '', /^(plot:12|line:metric@12)$/, `${label}: pending pointer hover hit targets hour 12`);
      };

      const verifyPointsKeyboardCancelsPendingHover = async (mode: 'focusKey' | 'pointsNavigate') => {
        const mountedPoints = await act<PointsMount>(`mountPointsHost(${JSON.stringify(mode)})`);
        try {
          assert.ok(mountedPoints.pipeId > 0, `${mode}: mounted points FamilyHost`);
          assert.deepEqual(mountedPoints.navKeys.slice(0, 3), ['plot:0', 'plot:3', 'plot:6'], `${mode}: chart exposes expected nav stops`);
          if (mode === 'focusKey') {
            assert.equal(mountedPoints.initialTooltip.open, true, 'onFocusKey: initial focus opens tooltip');
            assert.equal(mountedPoints.initialTooltip.subtitle, mountedPoints.date0, 'onFocusKey: initial focus tooltip shows hour 0');
            assert.deepEqual(mountedPoints.initialTooltip.rows, [['Metric', '10']], 'onFocusKey: initial focus tooltip shows hour 0 value');
          }

          if (mode === 'pointsNavigate') {
            await page.press('ArrowRight');
            await queueHour12Hover(mountedPoints.hour12Point.x, mountedPoints.hour12Point.y, 'pointsNavigate');
            await act('resolvePointsNavigate(3)');
          } else {
            await queueHour12Hover(mountedPoints.hour12Point.x, mountedPoints.hour12Point.y, 'focusKey');
            await page.press('ArrowRight');
          }
          const focusedTip = await act<VisibleTip>('waitPointsTooltipHour(3)');
          assert.equal(focusedTip.open, true, `${mode}: keyboard move renders visible tooltip`);
          assert.equal(focusedTip.subtitle, mountedPoints.date3, `${mode}: visible tooltip shows keyboard-selected hour 3`);
          assert.deepEqual(focusedTip.rows, [['Metric', '30']], `${mode}: visible tooltip shows hour 3 value`);

          const afterUnpinnedReply = await act<DeliveredState>(`deliverHeldPointsHit(${mountedPoints.pipeId})`);
          assert.equal(afterUnpinnedReply.visibleTooltip.open, true, `${mode}: visible tooltip stays open after delayed pointer reply`);
          assert.equal(afterUnpinnedReply.visibleTooltip.subtitle, mountedPoints.date3, `${mode}: delayed hour-12 pointer reply does not overwrite visible hour-3 tooltip`);
          assert.deepEqual(afterUnpinnedReply.visibleTooltip.rows, [['Metric', '30']], `${mode}: visible tooltip value remains hour 3`);
          assert.equal(afterUnpinnedReply.inspecting, null, `${mode}: delayed pointer reply does not re-inspect the chart`);
          assert.equal(afterUnpinnedReply.hoverHours.at(-1), 3, `${mode}: reported hover hour stays at keyboard-selected hour 3`);
          assert.equal(afterUnpinnedReply.hoverHours.includes(12), false, `${mode}: delayed pointer reply never reports hour 12`);
          if (mode === 'pointsNavigate') {
            assert.deepEqual(afterUnpinnedReply.navRequests, [{ key: 'ArrowRight', currentHour: null }], 'pointsNavigate: ArrowRight routed through onPointsNavigate');
          }

          await pressPinKey();
          const pinnedTip = await act<VisibleTip>('waitPinnedPointsTooltip(3)');
          assert.equal(pinnedTip.open, true, `${mode}: pressing P pins the keyboard-focused hour-3 tooltip`);
          assert.equal(pinnedTip.subtitle, mountedPoints.date3, `${mode}: pinned tooltip preserves hour-3 point subtitle`);
          assert.equal(pinnedTip.pinned, `Pinned at ${mountedPoints.date24}`, `${mode}: pinned tooltip shows inspection time separately`);
          assert.deepEqual(pinnedTip.rows, [['Metric', '30']], `${mode}: pinned tooltip shows hour 3 value`);

          await act(`holdPointsHits(${mountedPoints.pipeId})`);
          if (mode === 'pointsNavigate') {
            await page.press('ArrowRight');
            await queueHour12Hover(mountedPoints.hour12Point.x + 2, mountedPoints.hour12Point.y, 'pointsNavigate pinned');
            await act('resolvePointsNavigate(6)');
          } else {
            await queueHour12Hover(mountedPoints.hour12Point.x + 2, mountedPoints.hour12Point.y, 'focusKey pinned');
            await page.press('ArrowRight');
          }
          await act(`waitPointsFocusInstalled(${mountedPoints.pipeId}, 6)`);

          const afterPinnedReply = await act<DeliveredState>(`deliverHeldPointsHit(${mountedPoints.pipeId})`);
          assert.equal(afterPinnedReply.visibleTooltip.open, true, `${mode}: pinned tooltip remains visible after keyboard move and delayed pointer reply`);
          assert.equal(afterPinnedReply.visibleTooltip.subtitle, mountedPoints.date3, `${mode}: pinned tooltip preserves hour-3 subtitle`);
          assert.equal(afterPinnedReply.visibleTooltip.pinned, `Pinned at ${mountedPoints.date24}`, `${mode}: pinned tooltip keeps inspection pin line`);
          assert.deepEqual(afterPinnedReply.visibleTooltip.rows, [['Metric', '30']], `${mode}: pinned tooltip content stays at hour 3`);
          assert.equal(afterPinnedReply.inspecting, null, `${mode}: delayed pointer reply while pinned does not re-inspect hour 12`);
          assert.equal(afterPinnedReply.hoverHours.at(-1), 6, `${mode}: keyboard focus moved hover hour to 6 while preserving the pinned tooltip`);
          assert.equal(afterPinnedReply.hoverHours.includes(12), false, `${mode}: delayed pointer reply while pinned never reports hour 12`);
          if (mode === 'pointsNavigate') {
            assert.deepEqual(
              afterPinnedReply.navRequests,
              [{ key: 'ArrowRight', currentHour: null }, { key: 'ArrowRight', currentHour: 3 }],
              'pointsNavigate: second ArrowRight observed keyboard focus preserved at hour 3',
            );
          }

          await page.press('Escape');
          await pressPinKey();
          const repinnedTip = await act<VisibleTip>('waitPinnedPointsTooltip(6)');
          assert.equal(repinnedTip.open, true, `${mode}: unpinning and pinning again locks onto the preserved keyboard-focused hour 6`);
          assert.equal(repinnedTip.subtitle, mountedPoints.date6, `${mode}: re-pinned tooltip preserves hour 6 subtitle`);
          assert.equal(repinnedTip.pinned, `Pinned at ${mountedPoints.date24}`, `${mode}: re-pinned tooltip shows inspection time separately`);
          assert.deepEqual(repinnedTip.rows, [['Metric', '60']], `${mode}: re-pinned tooltip shows hour 6 value`);
        } finally {
          await act('unmountPointsHost()');
        }
      };

      await t.test('points keyboard onFocusKey cancels a pending pointer hover reply and preserves focus and pinned tooltip', async () => {
        await verifyPointsKeyboardCancelsPendingHover('focusKey');
      });

      await t.test('points keyboard onPointsNavigate focusHour cancels a pending pointer hover reply and preserves focus and pinned tooltip', async () => {
        await verifyPointsKeyboardCancelsPendingHover('pointsNavigate');
      });
    } finally {
      cdp.close();
    }

    const generic = await act<{
      firstPicture: boolean;
      mountCommits: number;
      quiet: { hoursAdvanced: number; commits: number; binds: number; paints: number };
      rankedHovers: unknown[];
      steady: { commits: number; binds: number; paints: number; diagnosticLines: string[]; title: string };
      titleAfterPartialChange: { label: string; tooltip: string };
      paused: { commits: number; binds: number; paints: number };
      activatedSubject: string | null;
      activatedMatchesInstalled: boolean;
    }>('testGenericHostFrames()');
    assert.equal(generic.firstPicture, true, 'generic host installs its first picture');
    assert.deepEqual(generic.rankedHovers, [[90, ['NEW', 'OLD']], [90, ['NEXT']]], 'a stationary hit reports a different country only when it enters the picture');
    assert.ok(generic.mountCommits > 0, 'the generic host render counter observes mounting');
    assert.ok(generic.quiet.hoursAdvanced > 0, 'quiet playback advanced the clock');
    assert.deepEqual([generic.quiet.commits, generic.quiet.binds, generic.quiet.paints], [0, 0, 0], 'quiet playback ticks: no React render, no bind, no paint');
    assert.ok(generic.steady.paints > 0, 'steady playback frames repaint in the lane');
    assert.deepEqual([generic.steady.commits, generic.steady.binds], [0, 0], 'steady playback frames: no React render, no bind');
    assert.ok(generic.steady.diagnosticLines.includes('Recorded warning 19'), 'changed warnings still reach the diagnostics consumer');
    assert.equal(generic.steady.title, '23 countries', 'the partial title follows without a React commit');
    assert.deepEqual(generic.titleAfterPartialChange, { label: '4 countries', tooltip: 'Some countries were not recorded' });
    assert.deepEqual([generic.paused.commits, generic.paused.binds, generic.paused.paints], [0, 0, 0], 'paused host settles and sleeps');
    assert.equal(generic.activatedSubject, 'GER', 'Enter activates the focused row from the installed picture');
    assert.equal(generic.activatedMatchesInstalled, true, 'the action carries the installed picture id');

    const still = await act<{ shown: boolean; installs: number; storeUpdates: number; commits: number }>('testGenericStationaryTooltip()');
    assert.equal(still.shown, true, 'the focused row shows its tooltip');
    assert.ok(still.installs >= 20, `twenty same-hour installs happened (${still.installs})`);
    assert.deepEqual([still.storeUpdates, still.commits], [0, 0], `a stationary tooltip across installs: no tooltip-store update, no React render including TooltipLayer (${still.installs} installs)`);

    const statics = await act<{ rounds: number; commits: number; binds: number; staticsSupplied: number; generationKept: boolean; mode: string }>('testStaticPanelsReplaced()');
    assert.ok(!statics.mode.startsWith('failed'), `the static host draws (${statics.mode})`);
    assert.deepEqual([statics.binds, statics.generationKept], [0, true], `replacing only a mounted host's static panels ${statics.rounds} times binds nothing and keeps the binding generation (R4-S4: ${statics.binds} binds)`);
    assert.equal(statics.staticsSupplied, statics.rounds, 'each new panel set is one statics supply');
    assert.equal(statics.commits, statics.rounds, 'and costs one React commit, the one that passed the panels');

    const data = await act<{ rounds: number; binds: number; supplies: number; tilesSupplied: readonly (string | null)[]; hoursSupplied: readonly (number | null)[]; pagesSupplied: readonly unknown[]; artSupplied: readonly unknown[]; generationKept: boolean }>('testDataSupplied()');
    assert.deepEqual([data.binds, data.generationKept], [0, true], `${data.rounds} rounds of new tiles, hover answers, row pages and art bind nothing and keep the binding generation, so the installed picture is not dimmed and in-flight pictures are not refused (${data.binds} binds)`);
    const rounds = Array.from({ length: data.rounds }, (_, at) => at + 1);
    assert.equal(data.supplies, data.rounds * 2, 'each round changes one data field alone, and that change is one supply, as is each art arrival');
    assert.deepEqual(data.tilesSupplied, rounds.filter(round => round % 3 === 1).map(round => `GER:${round}`), 'every tile publish is supplied');
    assert.deepEqual(data.hoursSupplied, [null, ...rounds.filter(round => round % 3 === 2)], 'every hover answer is supplied on its own');
    assert.deepEqual(data.pagesSupplied, [null, ...rounds.filter(round => round % 3 === 0)], 'every row page set is supplied on its own');
    assert.deepEqual(data.artSupplied, rounds, 'every art arrival is supplied');

    const corrected = await act<{ rounds: number; binds: number; generationKept: boolean; windows: unknown[] }>('testRowWindowCorrected()');
    assert.deepEqual([corrected.binds, corrected.generationKept], [0, true], `a row window corrected by ${corrected.rounds} installed pictures is supplied, not bound (${corrected.binds} binds)`);
    assert.deepEqual(corrected.windows, [10, 20, 30, 40, 50].map(first => ({ first, count: 4 })), 'each corrected window reaches the lane');

    const span = await act<{ hoursAdvanced: number; answers: number; binds: number; mode: string }>('testSpanEndOnly()');
    assert.ok(span.hoursAdvanced > 0 && span.answers >= 5, `playing a followed span read brings new answers (${span.answers} over ${span.hoursAdvanced} hours; ${span.mode})`);
    assert.equal(span.binds, 0, `${span.answers} new answers that only extend the span's end bind nothing (${span.binds} binds)`);

    const tuple = await act<{
      blockedMeasured: boolean;
      blockedShown: boolean;
      gapShown: boolean;
      pictureAfterGap: boolean;
      subscriptions: { before: number[]; duringGap: number[]; afterGap: number[] };
      activatedDuringGap: number;
      activatedAfterGap: number;
      description: string | null;
      clearedDescription: boolean;
      activatedId: number | null;
      activatedHour: number | null;
      viewId: number | null;
      viewHour: number | null;
    }>('testGenericInstalledTuple()');
    assert.equal(tuple.blockedMeasured, true, 'a blocked host still measures its body, so a cold chart can ask for its first tiles');
    assert.equal(tuple.blockedShown, true, 'the blocked state shows inside the frame');
    assert.equal(tuple.gapShown, true, 'a recorded chart gap still shows its reason');
    assert.deepEqual(tuple.subscriptions.duringGap, tuple.subscriptions.before, 'the gap keeps the same native subscriptions');
    assert.deepEqual(tuple.subscriptions.afterGap, tuple.subscriptions.before, 'leaving the gap reuses the followed placement');
    assert.equal(tuple.pictureAfterGap, true, 'the picture is installed when the gap notice clears');
    assert.equal(tuple.activatedDuringGap, 0, 'the covered picture cannot receive actions');
    assert.equal(tuple.activatedAfterGap, 1, 'actions resume when the gap clears');
    assert.equal(tuple.description, 'Four countries ranked by factories', 'the installed description is what the body is described by');
    assert.equal(tuple.clearedDescription, true, 'the description goes when the picture goes');
    assert.equal(tuple.activatedId, tuple.viewId, 'Enter after forty played hours carries the picture Page shows now');
    assert.equal(tuple.activatedHour, tuple.viewHour, 'and its hour');

    const f12 = await act<{
      distinctCanvases: boolean;
      distinctPlacements: boolean;
      hasReaderA: boolean;
      hasReaderB: boolean;
      primaryStillInstalls: boolean;
      typeaheadKey: string | null;
    }>('testF12DualPlacementAndTypeahead()');
    assert.equal(f12.distinctCanvases, true, 'F12: co-mounted hosts under one widget key own distinct canvases');
    assert.equal(f12.distinctPlacements, true, 'F12: co-mounted hosts under one widget key own distinct placement IDs');
    assert.equal(f12.hasReaderA, true, 'F12: primary audit reader registered under its own placement');
    assert.equal(f12.hasReaderB, true, 'F12: secondary audit reader registered under its own placement');
    assert.equal(f12.primaryStillInstalls, true, 'F12: unmounting secondary leaves primary installing new frames');
    assert.equal(f12.typeaheadKey, 'ITA', 'F12: table typeahead focuses matching country row');

    const deep = await act<{
      deepRowCount: string | null;
      deepRowIndex: string | null;
      homeScrolled: boolean;
      homeScrollBinds: number;
      homeScrollKeptGen: boolean;
      homeArrived: boolean;
      homeActive: { key: string | null; rowIndex: string | null };
      endScrolled: boolean;
      endScrollBinds: number;
      endScrollKeptGen: boolean;
      endArrived: boolean;
      endActive: { key: string | null; rowIndex: string | null };
      scrollCancelLoaded: boolean;
      scrollCancelArrived: boolean;
      scrollCancelKey: string | null;
      keyCancelLoaded: boolean;
      keyCancelArrived: boolean;
      keyCancelKey: string | null;
      endUpLoaded: boolean;
      endUpParkedTag: string | null;
      endUpArrived: boolean;
      endUpActive: { key: string | null; rowIndex: string | null };
      expectedPageDown: number;
      pageDownArrived: boolean;
      pageDownActive: { key: string | null; rowIndex: string | null };
      foldedLoaded: boolean;
      foldedArrived: boolean;
      foldedBindSettled: boolean;
      foldedActive: { key: string | null; rowIndex: string | null };
      foldedUpSettled: boolean;
      foldedUpActive: { key: string | null; rowIndex: string | null };
      playCommits: number;
      playBinds: number;
      playPaints: number;
      homeParked: (string | null)[];
      homeFocusRows: (string | null)[];
    }>('testDeepLogHomeEnd()');
    assert.equal(deep.deepRowCount, '2001', 'deep log announces the whole log row count');
    assert.equal(deep.deepRowIndex, '612', 'deeply scrolled row announces its absolute row index');
    assert.equal(deep.homeScrolled, true, 'Home scrolls a deeply scrolled log to the top');
    assert.deepEqual([deep.homeScrollBinds, deep.homeScrollKeptGen], [0, true], 'Home scroll goes through view supply with no rebind');
    assert.equal(deep.homeArrived, true, 'Home focuses absolute row 0 once its page installs');
    assert.deepEqual(deep.homeActive, { key: 'R0', rowIndex: '2' }, 'Home focuses R0 with aria-rowindex 2');
    assert.deepEqual(deep.homeParked, [null], 'while Home waits for its page with focus parked on the table, the row it left is out of the picture, so the focus tooltip is for no row: reported once, as focus leaving a row is');
    assert.deepEqual(deep.homeFocusRows, [null, 'R0'], 'and the row Home lands on is reported once, by the install that lands focus on it');
    assert.equal(deep.endScrolled, true, 'End scrolls a deeply scrolled log to the bottom');
    assert.deepEqual([deep.endScrollBinds, deep.endScrollKeptGen], [0, true], 'End scroll goes through view supply with no rebind');
    assert.equal(deep.endArrived, true, 'End focuses the last row once its page installs');
    assert.deepEqual(deep.endActive, { key: 'R1999', rowIndex: '2001' }, 'End focuses R1999 with aria-rowindex total + 1');
    assert.deepEqual([deep.scrollCancelLoaded, deep.scrollCancelArrived], [true, true], 'scroll-cancel test observed loading before cancel and target after release');
    assert.notEqual(deep.scrollCancelKey, 'R1999', 'a user scroll cancels a pending ordinal before it arrives');
    assert.deepEqual([deep.keyCancelLoaded, deep.keyCancelArrived], [true, true], 'key-cancel test observed loading before cancel and target after release');
    assert.notEqual(deep.keyCancelKey, 'R1999', 'pressing another key cancels a pending ordinal before it arrives');
    assert.deepEqual([deep.endUpLoaded, deep.endUpArrived], [true, true], 'End followed by ArrowUp while loading waits for and focuses 1998');
    assert.equal(deep.endUpParkedTag, 'TABLE', 'parked focus stays on the table while loading placeholders wait for a pending ordinal');
    assert.deepEqual(deep.endUpActive, { key: 'R1998', rowIndex: '2000' }, 'End then ArrowUp focuses R1998, not R0');
    assert.equal(deep.pageDownArrived, true, 'PageDown from the bottom visible row crosses the overscan slice');
    assert.deepEqual(deep.pageDownActive, { key: `R${deep.expectedPageDown}`, rowIndex: String(deep.expectedPageDown + 2) }, 'PageDown lands a full viewport down');
    assert.deepEqual([deep.foldedLoaded, deep.foldedArrived, deep.foldedBindSettled], [true, true, true], 'End on a final window with a long folded run settles and survives the subsequent bind');
    assert.equal(deep.foldedActive.key, 'R1999', 'End keeps focus on the final row R1999 after revealing it above the viewport');
    assert.equal(deep.foldedUpSettled, true, 'ArrowUp from the folded final row settles its bind');
    assert.equal(deep.foldedUpActive.key, 'R1998', 'ArrowUp inside the anchored folded window retains focus on R1998');
    assert.ok(deep.playPaints > 0, 'playback repaints the deep log in the lane');
    assert.deepEqual([deep.playCommits, deep.playBinds], [0, 0], 'played hours cause no React render and no rebind');

    const deferred = await act<{
      pre: { hourA: string | null; hourB: string | null; heldA: string | null; heldB: string | null; topA: string | null; topB: string | null; captionA: string | null; headCountA: number; cellCountA: number };
      played: {
        installsA: number; installsB: number; viewHourA: number | null; viewHourB: number | null;
        contentA: number; contentB: number; holdAttrsA: number; holdAttrsB: number;
        heldA: string | null; heldB: string | null; busyA: string | null; busyB: string | null;
        hourA: string | null; hourB: string | null; topA: string | null; topB: string | null;
        captionA: string | null; captionB: string | null; headCountA: number; cellCountA: number;
      };
      focusedNow: {
        heldA: string | null; busyA: string | null; hourA: string | null; viewHourA: string; topA: string | null;
        heldB: string | null; busyB: string | null; hourB: string | null; topB: string | null; contentB: number;
      };
      whileFocused: {
        topA: string | null; heldA: string | null; hourA: string | null;
        contentB: number; topB: string | null; heldB: string | null; hourB: string | null;
      };
      afterSeek: { hourA: string | null; hourB: string | null; heldA: string | null; heldB: string | null; topA: string | null; topB: string | null };
      afterSeekPlayed: { contentA: number; contentB: number; heldA: string | null; heldB: string | null; hourA: string | null; hourB: string | null };
      afterOwnerClear: { tabIndexA: number; hourA: string | null; rowsA: number };
      afterOwnerRecover: { tabIndexA: number; hourA: string | null; topA: string | null; rowsA: number };
      paused: {
        heldA: string | null; heldB: string | null; busyA: string | null; busyB: string | null;
        hourA: string | null; hourB: string | null; viewHourA: string; viewHourB: string; topA: string | null; topB: string | null;
        captionA: string | null; captionB: string | null; headCountA: number; cellCountA: number;
      };
      listboxSameHour: { held: string | null; busy: string | null; hour: string | null };
      coalescedEmpty: { rows: number; tabIndex: number };
      coalescedAfter: { recovered: boolean; dropped: boolean; rows: number; tabIndex: number; text: string };
      pausedOmitted: { dropped: boolean; minRows: number; minHeads: number; held: string | null; hour: string | null };
      coalescedSeek: { recovered: boolean; dropped: boolean; held: string | null; top: string | null; hour: number };
    }>('testDeferredScreenReaderMirrors()');
    assert.deepEqual(deferred.pre, { hourA: '50', hourB: '50', heldA: null, heldB: null, topA: 'GER', topB: 'GER', captionA: 'Base summary', headCountA: 3, cellCountA: 3 }, 'pre-playback mirrors start fresh at hour 50 with matching headers and cells');
    assert.ok(deferred.played.installsA > 0 && deferred.played.installsB > 0 && (deferred.played.viewHourA ?? 0) > 50, 'playback installed newer hours on both widgets');
    assert.deepEqual([deferred.played.contentA, deferred.played.contentB], [0, 0], 'unfocused mirrors perform 0 DOM writes to thead/tbody/caption/rowcount during playback, even when summaryPartial transitions or a column is hidden');
    assert.deepEqual([deferred.played.headCountA, deferred.played.cellCountA], [3, 3], 'hiding a column during unfocused playback keeps thead aligned with held tbody cells until sync');
    assert.ok(deferred.played.holdAttrsA <= 2 && deferred.played.holdAttrsB <= 2, 'stale hold attributes are set once, not rewritten per frame');
    assert.deepEqual(
      [deferred.played.heldA, deferred.played.busyA, deferred.played.hourA, deferred.played.topA, deferred.played.captionA],
      ['stale', 'true', '50', 'GER', 'Base summary'],
      'unfocused primary mirror stays at pre-playback hour 50 with unchanged caption and marks itself stale',
    );
    assert.deepEqual(
      [deferred.played.heldB, deferred.played.busyB, deferred.played.hourB, deferred.played.topB, deferred.played.captionB],
      ['stale', 'true', '50', 'GER', 'Base summary'],
      'unfocused secondary mirror stays at pre-playback hour 50 with unchanged caption and marks itself stale',
    );
    assert.deepEqual(
      [deferred.focusedNow.heldA, deferred.focusedNow.busyA, deferred.focusedNow.hourA, deferred.focusedNow.topA],
      [null, null, deferred.focusedNow.viewHourA, 'ENG'],
      'focusing primary mid-playback flushes its mirror immediately and clears stale hold',
    );
    assert.deepEqual(
      [deferred.focusedNow.heldB, deferred.focusedNow.busyB, deferred.focusedNow.hourB, deferred.focusedNow.topB, deferred.focusedNow.contentB],
      ['stale', 'true', '50', 'GER', 0],
      'unfocused sibling remains stale with 0 DOM writes when primary receives focus',
    );
    assert.equal(deferred.whileFocused.topA, 'ITA', 'focused widget continues syncing live during playback');
    assert.equal(deferred.whileFocused.heldA, null, 'focused widget is not marked stale');
    assert.deepEqual([deferred.whileFocused.contentB, deferred.whileFocused.hourB, deferred.whileFocused.heldB, deferred.whileFocused.topB], [0, '50', 'stale', 'GER'], 'unfocused sibling still receives 0 DOM writes');
    assert.deepEqual(deferred.afterSeek, { hourA: '180', hourB: '180', heldA: null, heldB: null, topA: 'FRA', topB: 'FRA' }, 'seeking mid-playback settles and syncs both mirrors once');
    assert.deepEqual([deferred.afterSeekPlayed.contentA, deferred.afterSeekPlayed.contentB, deferred.afterSeekPlayed.heldA, deferred.afterSeekPlayed.heldB, deferred.afterSeekPlayed.hourA, deferred.afterSeekPlayed.hourB], [0, 0, 'stale', 'stale', '180', '180'], 'played frames after a seek resume deferring mirrors');
    assert.deepEqual(deferred.afterOwnerClear, { tabIndexA: 0, hourA: null, rowsA: 0 }, 'clearing the mirror on owner switch mid-playback exposes the fallback Tab stop on the table');
    assert.deepEqual([deferred.afterOwnerRecover.tabIndexA, deferred.afterOwnerRecover.topA, deferred.afterOwnerRecover.rowsA], [-1, 'GER', 4], 'owner switch mid-playback at the same seek repopulates the mirror and restores row Tab stops');
    assert.ok(deferred.afterOwnerRecover.hourA !== null, 'recovered mirror records its hour');
    assert.deepEqual(
      [deferred.paused.heldA, deferred.paused.heldB, deferred.paused.busyA, deferred.paused.busyB, deferred.paused.hourA, deferred.paused.hourB, deferred.paused.topA, deferred.paused.topB, deferred.paused.captionA, deferred.paused.captionB, deferred.paused.headCountA, deferred.paused.cellCountA],
      [null, null, null, null, deferred.paused.viewHourA, deferred.paused.viewHourB, 'GER', 'GER', 'Live summary. Partial during playback', 'Live summary. Partial during playback', 2, 2],
      'pausing flushes every shown mirror, header and caption to the installed picture and clears stale hold',
    );
    assert.deepEqual(deferred.listboxSameHour, { held: null, busy: null, hour: '50' }, 'an unfocused listbox with a summary is not marked stale or aria-busy on a same-hour hover install');
    assert.deepEqual(deferred.coalescedEmpty, { rows: 0, tabIndex: 0 }, 'an initially empty table exposes a fallback Tab stop');
    assert.deepEqual(
      [deferred.coalescedAfter.recovered, deferred.coalescedAfter.dropped, deferred.coalescedAfter.rows, deferred.coalescedAfter.tabIndex],
      [true, true, 1, -1],
      'if a paged table with a positive total starts with an empty window and its first visible gap mirror is dropped, the host requests and populates the mirror during playback',
    );
    assert.match(deferred.coalescedAfter.text, /Collector detached/, 'recovered gap mirror carries the gap reason');
    assert.deepEqual(deferred.pausedOmitted, { dropped: true, minRows: 4, minHeads: 3, held: 'stale', hour: '50' }, 'an omitted mirror arriving while paused keeps existing rows and headers held instead of wiping them');
    assert.deepEqual([deferred.coalescedSeek.recovered, deferred.coalescedSeek.dropped, deferred.coalescedSeek.held, deferred.coalescedSeek.top], [true, true, null, 'FRA'], 'if a settled seek’s mirror is lost before the host sees it, the host requests and commits it during playback');
    assert.ok(deferred.coalescedSeek.hour >= 180, 'recovered seek mirror advances past the seek hour');
  }));
});
