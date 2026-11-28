
use crate::layers::{Carried, Settling, Inputs, Keys, Layer, List, Retirement, RetirementFlag, Upstream, View};
use crate::playhead_host::mirror::{Mirror, Mirrors};
use playhead::Step;
use replay_columnar::manifest::Status;
use replay_data::{
    BranchId, Hour,
    rows::{Field, NativeValue, NavalCombatSideDetails, Opaque, TableId},
};
use std::{collections::BTreeMap, io, sync::Arc, time::Duration};
use viewer_engagements::{
    engaged::Engaged,
    engagement_history::{History, LAND, NAVAL, Provenance},
    naval_check,
};

pub struct Index {
    pub history: Arc<History>,
    pub branch: BranchId,
}

const COMBATS: [TableId; 2] = [TableId::LandCombats, TableId::NavalCombats];

const READ: [TableId; 3] = [TableId::LandCombats, TableId::NavalCombats, TableId::NavalCombatDetails];

const WHOLE: Duration = Duration::from_secs(120);

struct Kind {
    flags: BTreeMap<u64, Engaged>,
    provenance: Provenance,
    at: Option<Hour>,
    all: bool,
    owed: Keys,
}

impl Kind {
    fn new() -> Self {
        Self { flags: BTreeMap::new(), provenance: Provenance::Unindexed, at: None, all: true, owed: Keys::default() }
    }
}

pub struct Engagements {
    index: Option<Index>,
    retiring: RetirementFlag,
    viewer: Option<u32>,
    reads_vision: bool,
    sides: Option<List>,
    kinds: [Kind; 2],
    player_is_viewer: bool,
    statuses: [Option<Status>; READ.len()],
    frame: u64,
    marked: usize,
    changed: crate::layers::Changed,
    #[cfg(test)]
    fold_waits: std::cell::Cell<usize>,
}

pub const KINDS: [&str; 2] = ["land", "naval"];

impl Engagements {
    pub fn new(index: Option<Index>, viewer: Option<u32>) -> Self {
        Self {
            index,
            retiring: RetirementFlag::default(),
            viewer,
            reads_vision: false,
            sides: None,
            kinds: [Kind::new(), Kind::new()],
            player_is_viewer: false,
            statuses: [None; READ.len()],
            frame: 0,
            marked: 0,
            changed: crate::layers::Changed::default(),
            #[cfg(test)]
            fold_waits: std::cell::Cell::new(0),
        }
    }

    pub fn reading_vision(self) -> Self {
        Self { reads_vision: true, ..self }
    }

    fn take_viewer(&mut self, upstream: &Upstream<'_>) -> bool {
        let Some(vision) = upstream.get::<crate::vision::Vision>() else { return false };
        let viewer = vision.ours();
        let changed = self.viewer != viewer;
        self.viewer = viewer;
        changed
    }

    pub fn flags(&self) -> (&BTreeMap<u64, Engaged>, &BTreeMap<u64, Engaged>, [Provenance; 2]) {
        (&self.kinds[LAND].flags, &self.kinds[NAVAL].flags, [self.kinds[LAND].provenance, self.kinds[NAVAL].provenance])
    }

    pub fn marked(&self) -> usize {
        self.marked
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn viewer(&self) -> Option<u32> {
        self.viewer
    }

    pub fn fresh(&self) -> Self {
        let index = self.index.as_ref().map(|index| Index { history: Arc::clone(&index.history), branch: index.branch });
        Self { sides: self.sides, reads_vision: self.reads_vision, ..Self::new(index, self.viewer) }
    }

    fn read_all(&mut self) {
        for kind in &mut self.kinds {
            kind.all = true;
        }
    }

    fn head(&self, mirrors: &Mirrors, kind: usize) -> Option<Hour> {
        mirrors.get(COMBATS[kind])?.head()
    }

    fn player_hour(&self, mirrors: &Mirrors) -> Option<Hour> {
        [LAND, NAVAL].into_iter().find_map(|kind| self.head(mirrors, kind))
    }

    fn forget(&mut self, kind: usize) {
        let held: Vec<u64> = self.kinds[kind].flags.keys().copied().collect();
        for combat in held {
            self.changed.mark(KINDS[kind], combat);
        }
        if self.kinds[kind].provenance != Provenance::Unindexed {
            self.changed.everything();
        }
        self.kinds[kind] = Kind { all: false, ..Kind::new() };
    }

    fn mark(&mut self, mirrors: &Mirrors, kind: usize) {
        let (Some(index), Some(viewer)) = (&self.index, self.viewer) else {
            if !self.kinds[kind].flags.is_empty() || self.kinds[kind].all {
                self.forget(kind);
            }
            return;
        };
        let (branch, history) = (index.branch, Arc::clone(&index.history));
        let Some(head) = self.head(mirrors, kind) else {
            if !self.kinds[kind].flags.is_empty() || self.kinds[kind].all {
                self.forget(kind);
            }
            return;
        };
        let provenance = history.provenance(branch, head, viewer);
        let held = &self.kinds[kind];
        let from = held.at.filter(|_| !held.all && provenance == held.provenance);
        let changed = match (from, provenance) {
            (Some(from), Provenance::Indexed) => history.flags_changed(kind, branch, from, head, viewer),
            (Some(_), _) => Some(Vec::new()),
            (None, _) => None,
        };
        let marks: Vec<u64> = match changed {
            Some(changed) => changed,
            None => {
                let live = mirrors.get(COMBATS[kind]).into_iter().flat_map(|combats| combats.rows().filter_map(|slot| combats.key(slot)).map(|key| key as u64));
                live.chain(self.kinds[kind].flags.keys().copied()).collect()
            }
        };
        let frame = self.frame;
        for combat in marks {
            self.kinds[kind].owed.mark(combat, frame);
        }
        if provenance != self.kinds[kind].provenance {
            self.changed.everything();
        }
        (self.kinds[kind].at, self.kinds[kind].all, self.kinds[kind].provenance) = (Some(head), false, provenance);
    }

    fn settle_kind(&mut self, mirrors: &Mirrors, kind: usize) {
        if self.kinds[kind].owed.len() == 0 {
            return;
        }
        let (Some(index), Some(viewer), Some(head)) = (&self.index, self.viewer, self.kinds[kind].at) else {
            self.kinds[kind].owed.clear();
            return;
        };
        let (branch, history) = (index.branch, Arc::clone(&index.history));
        let combats = mirrors.get(COMBATS[kind]);
        let live = |combat: u64| combats.is_some_and(|combats| combats.slot(u128::from(combat)).is_some());
        let (asked, gone): (Vec<u64>, Vec<u64>) = self.kinds[kind].owed.take().into_iter().partition(|&combat| live(combat));
        self.marked += asked.len();
        for combat in gone {
            if self.kinds[kind].flags.remove(&combat).is_some() {
                self.changed.mark(KINDS[kind], combat);
            }
        }
        let found = match history.lookup(kind, branch, head, viewer, &asked) {
            Ok(found) => found,
            Err(_) => asked.iter().map(|&combat| (combat, Engaged::Unknown)).collect(),
        };
        let bytes = self.naval_bytes(mirrors, kind, &found);
        for (combat, flag) in found {
            let flag = match &bytes {
                Some(bytes) => naval_check::settle(flag, bytes.get(&combat)),
                None => flag,
            };
            if self.kinds[kind].flags.insert(combat, flag) != Some(flag) {
                self.changed.mark(KINDS[kind], combat);
            }
        }
    }

    fn naval_bytes(&self, mirrors: &Mirrors, kind: usize, found: &BTreeMap<u64, Engaged>) -> Option<BTreeMap<u64, [u8; 2]>> {
        if kind != NAVAL || !self.player_is_viewer {
            return None;
        }
        let undecided = found.iter().filter(|(_, flag)| matches!(flag, Engaged::Ambiguous(_) | Engaged::Unknown)).map(|(&combat, _)| combat);
        let (details, sides) = (mirrors.get(TableId::NavalCombatDetails)?, self.sides?);
        let bytes: BTreeMap<u64, [u8; 2]> = undecided
            .filter_map(|combat| {
                let slot = details.slot(u128::from(combat))?;
                let cell = details.list(sides, slot).value()?;
                let sides = <[NavalCombatSideDetails; 2]>::from_field(Field::Opaque(Opaque::Encoded(cell, details.format()))).ok()?;
                Some((combat, sides.each_ref().map(|side| side.engaged)))
            })
            .collect();
        Some(bytes)
    }

    pub fn history(&self) -> Option<&Arc<History>> {
        self.index.as_ref().map(|index| &index.history)
    }

    fn take_player(&mut self, mirrors: &Mirrors) {
        let player = match (&self.index, self.viewer, self.player_hour(mirrors)) {
            (Some(index), Some(viewer), Some(hour)) => index.history.recording_player(index.branch, hour, viewer),
            _ => false,
        };
        if player != self.player_is_viewer {
            self.player_is_viewer = player;
            self.kinds[NAVAL].all = true;
        }
    }

    fn take_statuses(&mut self, mirrors: &Mirrors) -> bool {
        let held = READ.map(|table| mirrors.get(table).and_then(Mirror::status));
        std::mem::replace(&mut self.statuses, held) != held
    }

    fn wait_for_the_fold(&self, mirrors: &Mirrors, settling: Settling) -> io::Result<()> {
        let (Some(index), Some(viewer), true) = (&self.index, self.viewer, settling.strict()) else { return Ok(()) };
        for kind in [LAND, NAVAL] {
            if let Some(head) = self.head(mirrors, kind) {
                #[cfg(test)]
                self.fold_waits.set(self.fold_waits.get() + 1);
                index.history.reached_while(index.branch, head, viewer, WHOLE, || !self.retiring.requested());
                if self.retiring.requested() {
                    return Err(io::Error::from(io::ErrorKind::Interrupted));
                }
            }
        }
        Ok(())
    }

    fn settle_flags(&mut self, mirrors: &Mirrors, settling: Settling) -> io::Result<()> {
        if self.take_statuses(mirrors) {
            self.read_all();
        }
        self.wait_for_the_fold(mirrors, settling)?;
        self.take_player(mirrors);
        for kind in [LAND, NAVAL] {
            self.mark(mirrors, kind);
            self.settle_kind(mirrors, kind);
        }
        Ok(())
    }
}

impl Layer for Engagements {
    fn retirement(&self) -> Option<Retirement> {
        let history = Arc::clone(&self.index.as_ref()?.history);
        let stop = self.retiring.handle();
        Some(Box::new(move || {
            stop();
            history.wake_waiters();
        }))
    }

    fn name(&self) -> &'static str {
        "engagements"
    }

    fn placed(&mut self, _view: &crate::layers::View) -> Option<u64> {
        Some(0)
    }

    fn inputs(&mut self, _view: &View, inputs: &mut Inputs<'_>) -> io::Result<()> {
        self.read_all();
        if self.reads_vision {
            inputs.after("vision");
        }
        for table in READ {
            inputs.table(table, true)?;
        }
        self.sides = Some(inputs.list(TableId::NavalCombatDetails, "sides")?);
        Ok(())
    }

    fn compose(&mut self, mirrors: &Mirrors) -> io::Result<()> {
        let marked = self.marked;
        self.read_all();
        self.settle_flags(mirrors, Settling::step())?;
        self.marked = marked;
        Ok(())
    }

    fn apply(&mut self, step: &Step, mirrors: &Mirrors) {
        let frame = self.frame;
        for changes in step.tables() {
            let table = TableId::ALL[changes.table()];
            let kind = match table {
                TableId::LandCombats => LAND,
                TableId::NavalCombats => NAVAL,
                TableId::NavalCombatDetails if self.player_is_viewer => NAVAL,
                _ => continue,
            };
            let Some((deleted, inserted)) = changes.deleted().keys().zip(changes.inserted().keys()) else {
                self.kinds[kind].all = true;
                continue;
            };
            let mut marks: Vec<u64> = deleted.iter().chain(inserted).map(|&key| key as u64).collect();
            if table == TableId::NavalCombatDetails {
                let mirror = mirrors.get(table);
                let sides = self.sides.map_or(usize::MAX, |sides| sides.column);
                marks.extend(
                    changes
                        .columns()
                        .iter()
                        .filter(|written| written.column() == sides)
                        .flat_map(|written| written.slots())
                        .filter_map(|&slot| mirror.and_then(|mirror| mirror.key(slot)))
                        .map(|key| key as u64),
                );
            }
            for combat in marks {
                self.kinds[kind].owed.mark(combat, frame);
            }
        }
    }

    fn compose_with(&mut self, mirrors: &Mirrors, upstream: &Upstream<'_>) -> io::Result<()> {
        self.take_viewer(upstream);
        self.compose(mirrors)
    }

    fn settle_with(&mut self, mirrors: &Mirrors, upstream: &Upstream<'_>, settling: Settling) -> io::Result<()> {
        if self.take_viewer(upstream) {
            self.read_all();
        }
        self.settle(mirrors, settling)
    }

    fn settle(&mut self, mirrors: &Mirrors, settling: Settling) -> io::Result<()> {
        self.frame += 1;
        self.settle_flags(mirrors, settling)
    }


    fn carried(&self) -> Carried {
        let owed: usize = self.kinds.iter().map(|kind| kind.owed.len() + if kind.all { kind.flags.len().max(1) } else { 0 }).sum();
        Carried { entities: owed }
    }

    fn held(&self) -> usize {
        self.kinds.iter().map(|kind| kind.flags.len() * 48 + kind.owed.bytes()).sum()
    }

    fn changed(&self) -> Option<&crate::layers::Changed> {
        Some(&self.changed)
    }

    fn clear_changed(&mut self) {
        self.changed.clear();
    }

    fn any(&self) -> &dyn std::any::Any {
        self
    }
}

#[cfg(test)]
#[path = "engagements/tests.rs"]
mod tests;
