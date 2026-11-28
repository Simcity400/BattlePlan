
use crate::{
    engaged::{self, Continuity, Engaged, Sides},
    engagement_progress::LandSides,
    icon_frames::{self, IconFold, IconHour, Kept},
    naval_check::{self, Summary},
    naval_icon_frames::naval_icon_hour,
    naval_sides::NavalSides,
};
use viewer_foundation::{tables::rows, visibility::Relations};
use replay_data::{BranchId, Hour, rows::NavalProvinceCombatRow, rows::tables};
use replay_frame::frame::DecodedFrame;
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    sync::{Arc, Condvar, Mutex, atomic::AtomicBool, atomic::Ordering},
    time::{Duration, Instant},
};

pub const LAND: usize = 0;
pub const NAVAL: usize = 1;
pub static SOURCES: [&dyn Sides; 2] = [&LandSides, &NavalSides];

pub const LAND_ICON: usize = 0;
pub const NAVAL_ICON: usize = 1;
pub const ICON_KINDS: usize = 2;

pub fn icon_source(kind: usize) -> usize {
    if kind == LAND_ICON { LAND } else { NAVAL }
}

pub fn icon_hour<F: replay_frame::frame::Tables + ?Sized>(
    kind: usize,
    frame: &F,
    flag: &dyn Fn(u64) -> Engaged,
) -> io::Result<IconHour> {
    if kind == LAND_ICON {
        icon_frames::land_hour(frame, flag)
    } else {
        naval_icon_hour(frame, flag)
    }
}

fn icon_combats(kind: usize, frame: &DecodedFrame) -> io::Result<Vec<u64>> {
    let mut combats: Vec<u64> = if kind == LAND_ICON {
        rows::<tables::LandCombats>(frame)?
            .rows()
            .iter()
            .map(|combat| combat.id)
            .collect()
    } else {
        rows::<tables::NavalCombats>(frame)?
            .rows()
            .iter()
            .map(|combat| combat.id)
            .collect()
    };
    combats.sort_unstable();
    combats.dedup();
    Ok(combats)
}

pub fn kept_frames(
    frame: &DecodedFrame,
    kind: usize,
    viewer: u32,
    flags: &BTreeMap<u64, Engaged>,
    index: Option<&History>,
) -> io::Result<(BTreeMap<u64, Kept>, Provenance)> {
    let provenance = match index {
        Some(index) => {
            let combats = icon_combats(kind, frame)?;
            match index.lookup_icons(kind, frame.branch, frame.hour, viewer, &combats) {
                Ok(found) => return Ok((found, Provenance::Indexed)),
                Err(missed) => missed,
            }
        }
        None => Provenance::Unindexed,
    };
    let flag = |combat: u64| flags.get(&combat).copied().unwrap_or(Engaged::Unknown);
    let hour = icon_hour(kind, frame, &flag)?;
    let mut fold = IconFold::default();
    fold.advance(&hour, Continuity::Gap, &mut Vec::new());
    Ok((
        fold.live()
            .iter()
            .map(|(&combat, &kept)| {
                let kept = match kept {
                    Kept::Unobserved => Kept::Unindexed,
                    other => other,
                };
                (combat, kept)
            })
            .collect(),
        provenance,
    ))
}

pub type IconPoints = BTreeMap<u64, Vec<(Hour, Option<Kept>)>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provenance {
    Indexed,
    Pending,
    OtherViewer,
    Unread,
    Unindexed,
}

impl Provenance {
    pub fn limitation(self) -> Option<&'static str> {
        match self {
            Self::Indexed => None,
            Self::Pending => Some(
                "engaged flag load-rebuilt; historical flag pending (the engaged index has not reached this hour)",
            ),
            Self::OtherViewer => Some(
                "engaged flag load-rebuilt; historical flag unavailable (the engaged index resolved another viewing country at this hour)",
            ),
            Self::Unread => Some(
                "engaged flag load-rebuilt; historical flag unavailable (the engaged index read no viewing country at or before this hour of the branch)",
            ),
            Self::Unindexed => Some(
                "engaged flag load-rebuilt; historical flag unavailable (built without the engaged index for this viewing country: a dump, an export, or an hour built before that index started)",
            ),
        }
    }
}

fn recorded_raw_viewer(
    frame: &DecodedFrame,
    links: &BTreeMap<u32, u32>,
    viewer: u32,
) -> Option<u32> {
    let [player] = viewer_foundation::fold_tables::whole::<tables::LocalPlayer, _>(frame)? else {
        return None;
    };
    let raw = player.viewing_country()?;
    (links.get(&raw).copied() == Some(viewer)).then_some(raw)
}

pub fn combats(
    frame: &DecodedFrame,
    kind: usize,
    viewer: u32,
    links: &BTreeMap<u32, u32>,
    relations: Result<&Relations, &'static str>,
    index: Option<&History>,
) -> io::Result<(BTreeMap<u64, Engaged>, Provenance)> {
    let combats = SOURCES[kind].combats(frame)?;
    let provenance = match index {
        Some(index) => match index.lookup(kind, frame.branch, frame.hour, viewer, &combats) {
            Ok(found) => return Ok((found, Provenance::Indexed)),
            Err(missed) => missed,
        },
        None => Provenance::Unindexed,
    };
    let sides = SOURCES[kind].sides(frame)?;
    let zero_visibility = viewer_foundation::visibility::ZeroVisibility::read_tables(frame, links);
    let viewer_raw = recorded_raw_viewer(frame, links, viewer);
    let snapshot = Arc::new(engaged::Snapshot {
        links: links.clone(),
        relations: relations.cloned(),
        zero_visibility,
        controllers: None,
    });
    let mut history = engaged::History::default();
    history.advance(
        engaged::Sample {
            viewer: Some(viewer),
            viewer_raw,
            alternate_viewer: None,
            alternate_viewer_raw: None,
            recording: false,
            snapshot: &snapshot,
            refreshes: engaged::RefreshWitness::Unavailable,
            sides: sides.sides,
            complete: sides.complete,
            removal: sides.removal,
        },
        Continuity::Load,
    );
    Ok((
        combats
            .into_iter()
            .map(|combat| (combat, history.combat(combat)))
            .collect(),
        provenance,
    ))
}

#[derive(Clone, Debug)]
pub struct CombatFlags {
    pub land: BTreeMap<u64, Engaged>,
    pub naval: BTreeMap<u64, Engaged>,
    pub land_provenance: Provenance,
    pub naval_provenance: Provenance,
}

impl Default for CombatFlags {
    fn default() -> Self {
        Self {
            land: BTreeMap::new(),
            naval: BTreeMap::new(),
            land_provenance: Provenance::Unindexed,
            naval_provenance: Provenance::Unindexed,
        }
    }
}

impl CombatFlags {
    pub fn read(
        frame: &DecodedFrame,
        viewer: u32,
        links: &BTreeMap<u32, u32>,
        relations: Result<&Relations, &'static str>,
        index: Option<&History>,
    ) -> io::Result<Self> {
        let (mut naval, naval_provenance) = combats(frame, NAVAL, viewer, links, relations, index)?;
        naval_check::settle_recorded(frame, links, viewer, &mut naval)?;
        let (land, land_provenance) = combats(frame, LAND, viewer, links, relations, index)?;
        Ok(Self {
            land,
            naval,
            land_provenance,
            naval_provenance,
        })
    }

    pub fn entry(&self, combat: u64, kind: u8) -> Engaged {
        let flags = if kind == NavalProvinceCombatRow::NAVAL {
            &self.naval
        } else {
            &self.land
        };
        flags.get(&combat).copied().unwrap_or(Engaged::Unknown)
    }

    pub fn engaged_entries(
        &self,
        row: Option<&NavalProvinceCombatRow>,
        complete: bool,
        count: usize,
    ) -> Option<bool> {
        let Some(row) = row else {
            return complete.then_some(count == 0);
        };
        let (mut engaged, mut undecided) = (0, 0);
        for (&combat, &kind) in row.combats.iter().zip(&row.kinds) {
            if engaged >= count {
                break;
            }
            match self.entry(combat, kind) {
                Engaged::Yes => engaged += 1,
                Engaged::No => {}
                Engaged::Ambiguous(_) | Engaged::Unknown => undecided += 1,
            }
        }
        if engaged >= count {
            Some(true)
        } else {
            (engaged + undecided < count).then_some(false)
        }
    }
}

pub type Changes = BTreeMap<(u64, u8), Vec<(Hour, Engaged)>>;

#[derive(Debug, Default)]
pub struct Touched {
    hours: Vec<(Hour, u32)>,
    ids: Vec<u64>,
}

impl Touched {
    fn record(&mut self, hour: Hour, ids: impl IntoIterator<Item = u64>) {
        let at = u32::try_from(self.ids.len()).expect("the engaged index's hour log holds under four billion changes");
        self.ids.extend(ids);
        if self.ids.len() > at as usize {
            self.hours.push((hour, at));
        }
    }

    fn between(&self, from: Hour, to: Hour) -> Vec<u64> {
        let bound = |hour| self.hours.get(self.hours.partition_point(|&(held, _)| held <= hour)).map_or(self.ids.len(), |&(_, at)| at as usize);
        let mut ids = self.ids[bound(from)..bound(to)].to_vec();
        ids.sort_unstable();
        ids.dedup();
        ids
    }
}

#[derive(Debug, Default)]
pub struct Folded {
    points: Vec<Changes>,
    icons: Vec<IconPoints>,
    touched: Vec<Touched>,
    icon_touched: Vec<Touched>,
}

impl Folded {
    fn new() -> Self {
        Self {
            points: vec![BTreeMap::new(); SOURCES.len()],
            icons: vec![BTreeMap::new(); ICON_KINDS],
            touched: (0..SOURCES.len()).map(|_| Touched::default()).collect(),
            icon_touched: (0..ICON_KINDS).map(|_| Touched::default()).collect(),
        }
    }

    pub fn points(&self) -> &[Changes] {
        &self.points
    }

    pub fn icons(&self) -> &[IconPoints] {
        &self.icons
    }

    pub fn record(&mut self, kind: usize, hour: Hour, changed: &[((u64, u8), Engaged)], ended: &[(u64, u8)]) {
        let points = &mut self.points[kind];
        let mut touched: Vec<u64> = Vec::with_capacity(changed.len());
        for &(key, value) in changed {
            let changes = points.entry(key).or_default();
            if changes.last().is_none_or(|(_, last)| *last != value) {
                changes.push((hour, value));
                touched.push(key.0);
            }
        }
        self.touched[kind].record(hour, touched);
        for key in ended {
            if let Some(changes) = points.get_mut(key) {
                changes.shrink_to_fit();
            }
        }
    }

    pub fn record_icons(&mut self, kind: usize, hour: Hour, changed: &[(u64, Option<Kept>)]) {
        for &(combat, kept) in changed {
            self.icons[kind].entry(combat).or_default().push((hour, kept));
        }
        self.icon_touched[kind].record(hour, changed.iter().map(|&(combat, _)| combat));
    }
}

#[derive(Default)]
pub struct Covered {
    pub first: Hour,
    pub last: Hour,
    pub perspective: Folded,
    pub recording: Folded,
    pub viewers: Vec<(Hour, u32)>,
    pub players: Vec<(Hour, Option<u32>)>,
}

pub fn at<T: Copy>(changes: &[(Hour, T)], hour: Hour) -> Option<T> {
    let at = changes.partition_point(|(from, _)| *from <= hour);
    Some(changes.get(at.checked_sub(1)?)?.1)
}

impl Covered {
    pub fn new(hour: Hour) -> Self {
        Self { first: hour, last: hour, perspective: Folded::new(), recording: Folded::new(), viewers: Vec::new(), players: Vec::new() }
    }

    pub fn fold(&mut self, recording: bool) -> &mut Folded {
        if recording { &mut self.recording } else { &mut self.perspective }
    }

    pub fn folds(&self) -> [&Folded; 2] {
        [&self.perspective, &self.recording]
    }

    fn viewer(&self, hour: Hour) -> Option<u32> {
        at(&self.viewers, hour)
    }

    fn one_track(&self, from: Hour, to: Hour) -> bool {
        let steady = |mut hours: Box<dyn Iterator<Item = Hour> + '_>| !hours.any(|hour| hour > from && hour <= to);
        steady(Box::new(self.viewers.iter().map(|&(hour, _)| hour))) && steady(Box::new(self.players.iter().map(|&(hour, _)| hour)))
    }

    fn answers_viewer(&self, hour: Hour, viewer: u32) -> Result<(), Provenance> {
        match self.viewer(hour) {
            Some(folded) if folded == viewer => Ok(()),
            Some(_) => Err(Provenance::OtherViewer),
            None => Err(Provenance::Unread),
        }
    }

    fn points_for(&self, hour: Hour, viewer: u32) -> Result<&Folded, Provenance> {
        if self.recording_player(hour, viewer) {
            return Ok(&self.recording);
        }
        self.answers_viewer(hour, viewer)?;
        Ok(&self.perspective)
    }

    pub fn recording_player(&self, hour: Hour, viewer: u32) -> bool {
        at(&self.players, hour).flatten() == Some(viewer)
    }
}

fn provenance_in(
    branches: &BTreeMap<BranchId, Covered>,
    branch: BranchId,
    hour: Hour,
    viewer: u32,
) -> Provenance {
    let Some(covered) = branches
        .get(&branch)
        .filter(|covered| (covered.first..=covered.last).contains(&hour))
    else {
        return Provenance::Pending;
    };
    match covered.points_for(hour, viewer) {
        Ok(_) => Provenance::Indexed,
        Err(provenance) => provenance,
    }
}

#[derive(Default)]
struct Branches {
    held: BTreeMap<BranchId, Covered>,
    pending: BTreeSet<(BranchId, Hour)>,
    landed: viewer_runtime::landed::Published<u64>,
}

impl Branches {
    fn watch(&mut self, branch: BranchId, hour: Hour) {
        self.pending.insert((branch, hour));
    }

    fn reached(&mut self, branch: BranchId, first: Hour, last: Hour) {
        let before = self.pending.len();
        self.pending.retain(|&(held, hour)| held != branch || !(first..=last).contains(&hour));
        if self.pending.len() != before {
            self.landed.inc();
        }
    }
}

#[derive(Default)]
pub struct History {
    branches: Mutex<Branches>,
    folded: Condvar,
    pub check: Mutex<Summary>,
    pub cancelled: AtomicBool,
}

impl History {
    pub fn byte_check(&self) -> Summary {
        self.check.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn covers(&self, branch: BranchId, hour: Hour) -> bool {
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let covered = state
            .held
            .get(&branch)
            .is_some_and(|covered| (covered.first..=covered.last).contains(&hour));
        if !covered {
            state.watch(branch, hour);
        }
        covered
    }

    pub fn recording_player(&self, branch: BranchId, hour: Hour, viewer: u32) -> bool {
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let Some(covered) = state
            .held
            .get(&branch)
            .filter(|covered| (covered.first..=covered.last).contains(&hour))
        else {
            state.watch(branch, hour);
            return false;
        };
        covered.recording_player(hour, viewer)
    }

    pub fn record_hour(&self, branch: BranchId, hour: Hour, update: impl FnOnce(&mut Covered)) {
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let (first, last) = {
            let covered = state.held.entry(branch).or_insert_with(|| Covered::new(hour));
            covered.last = hour;
            update(covered);
            (covered.first, covered.last)
        };
        state.reached(branch, first, last);
        drop(state);
        self.folded.notify_all();
    }

    pub fn inspect<T>(&self, read: impl FnOnce(&BTreeMap<BranchId, Covered>) -> T) -> T {
        let state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        read(&state.held)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn insert_branch(&self, branch: BranchId, covered: Covered) {
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let (first, last) = (covered.first, covered.last);
        state.held.insert(branch, covered);
        state.reached(branch, first, last);
        drop(state);
        self.folded.notify_all();
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn answers(&self, frame: &DecodedFrame, viewer: u32) -> bool {
        SOURCES.iter().enumerate().all(|(kind, source)| {
            source.combats(frame).is_ok_and(|combats| {
                self.lookup(kind, frame.branch, frame.hour, viewer, &combats)
                    .is_ok()
            })
        })
    }

    pub fn lookup(
        &self,
        kind: usize,
        branch: BranchId,
        hour: Hour,
        viewer: u32,
        combats: &[u64],
    ) -> Result<BTreeMap<u64, Engaged>, Provenance> {
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let Some(covered) = state
            .held
            .get(&branch)
            .filter(|covered| (covered.first..=covered.last).contains(&hour))
        else {
            state.watch(branch, hour);
            return Err(Provenance::Pending);
        };
        let points = &covered.points_for(hour, viewer)?.points()[kind];
        let side = |combat: u64, side: u8| {
            points
                .get(&(combat, side))
                .and_then(|points| at(points, hour))
                .unwrap_or(Engaged::Unknown)
        };
        Ok(combats
            .iter()
            .map(|&combat| (combat, side(combat, 0).either(side(combat, 1))))
            .collect())
    }

    pub fn lookup_icons(
        &self,
        kind: usize,
        branch: BranchId,
        hour: Hour,
        viewer: u32,
        combats: &[u64],
    ) -> Result<BTreeMap<u64, Kept>, Provenance> {
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let Some(covered) = state
            .held
            .get(&branch)
            .filter(|covered| (covered.first..=covered.last).contains(&hour))
        else {
            state.watch(branch, hour);
            return Err(Provenance::Pending);
        };
        let points = if covered.recording_player(hour, viewer) {
            &covered.recording.icons()[kind]
        } else {
            covered.answers_viewer(hour, viewer)?;
            &covered.perspective.icons()[kind]
        };
        Ok(combats
            .iter()
            .filter_map(|&combat| {
                let points = points.get(&combat)?;
                let at = points.partition_point(|(from, _)| *from <= hour);
                Some((combat, points.get(at.checked_sub(1)?)?.1?))
            })
            .collect())
    }

    pub fn provenance(&self, branch: BranchId, hour: Hour, viewer: u32) -> Provenance {
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let provenance = provenance_in(&state.held, branch, hour, viewer);
        if provenance == Provenance::Pending {
            state.watch(branch, hour);
        }
        provenance
    }

    pub fn wake_waiters(&self) {
        drop(self.branches.lock().unwrap_or_else(|p| p.into_inner()));
        self.folded.notify_all();
    }

    pub fn reached_while(&self, branch: BranchId, hour: Hour, viewer: u32, limit: Duration, waiting: impl Fn() -> bool) -> Provenance {
        let until = Instant::now() + limit;
        let mut state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            let provenance = provenance_in(&state.held, branch, hour, viewer);
            if provenance != Provenance::Pending || self.cancelled.load(Ordering::Acquire) || !waiting() {
                return provenance;
            }
            let Some(left) = until
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
            else {
                return Provenance::Pending;
            };
            state = self
                .folded
                .wait_timeout(state, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    pub fn flags_changed(&self, kind: usize, branch: BranchId, from: Hour, to: Hour, viewer: u32) -> Option<Vec<u64>> {
        self.advance(branch, from, to, viewer, |fold| &fold.touched[kind])
    }

    pub fn icons_changed(&self, kind: usize, branch: BranchId, from: Hour, to: Hour, viewer: u32) -> Option<Vec<u64>> {
        self.advance(branch, from, to, viewer, |fold| &fold.icon_touched[kind])
    }

    fn advance(&self, branch: BranchId, from: Hour, to: Hour, viewer: u32, log: impl Fn(&Folded) -> &Touched) -> Option<Vec<u64>> {
        let state = self.branches.lock().unwrap_or_else(|p| p.into_inner());
        let covered = state.held.get(&branch)?;
        if from > to || from < covered.first || to > covered.last || !covered.one_track(from, to) {
            return None;
        }
        Some(log(covered.points_for(to, viewer).ok()?).between(from, to))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_moves_the_landed_count_only_when_it_reaches_a_queried_pending_hour() {
        let history = History::default();
        assert!(!history.covers(1, 5));
        let before = viewer_runtime::landed::count();
        for hour in 0..5 {
            history.record_hour(1, hour, |_| {});
        }
        assert_eq!(viewer_runtime::landed::count(), before, "earlier hours do not move the count");
        history.record_hour(1, 5, |_| {});
        let after = viewer_runtime::landed::count();
        assert!(after > before, "reaching the queried pending hour moves the count");
        for hour in 6..10 {
            history.record_hour(1, hour, |_| {});
        }
        assert_eq!(viewer_runtime::landed::count(), after, "later hours do not move the count");
    }
}
