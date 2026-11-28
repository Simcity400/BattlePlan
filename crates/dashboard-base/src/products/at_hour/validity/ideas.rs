use super::{Keys, Replay, Selection, TableId, VariableDates};
use crate::{Source, products::read_ahead::{self, Preparation}};
use replay_columnar::summary::Shape;
use replay_lanes::{lanes::status_reasons, points::cells};
use replay_recording::columnar_frames::TableCoverage;
use std::{collections::BTreeMap, io, sync::{Arc, Mutex, PoisonError}};

#[cfg(test)]
mod tests;

const RETAINED_BYTES: usize = 8 * 1024 * 1024;
const RUN_BYTES: usize = 1024;

struct Spec { table: TableId, fields: u64, shift: Option<u8> }

const SPECS: &[Spec] = &[
    Spec { table: TableId::ActiveIdeas, fields: 1, shift: Some(32) },
    Spec { table: TableId::ScriptVariables, fields: 1, shift: Some(0) },
    Spec { table: TableId::HiredAdvisors, fields: 2, shift: Some(32) },
    Spec { table: TableId::CountryCharacters, fields: 1, shift: None },
    Spec { table: TableId::AdvisorTokens, fields: 1, shift: None },
    Spec { table: TableId::CountryAppearance, fields: 240, shift: None },
    Spec { table: TableId::FactionAdvisors, fields: 1, shift: None },
    Spec { table: TableId::CountryRetiredCharacters, fields: 1, shift: None },
    Spec { table: TableId::ReservedCountryNaming, fields: 255, shift: None },
];

#[derive(Default)]
pub(super) struct IdeaDates {
    runs: BTreeMap<u32, (Arc<Preparation>, Option<Arc<RunDates>>)>,
    bytes: usize,
    building: bool,
}

pub(super) struct RunDates {
    span: (i32, i32),
    tables: Vec<TableDates>,
}

struct TableDates {
    table: TableId,
    fields: u64,
    shift: Option<u8>,
    statuses: Box<[i32]>,
    changes: Box<[(u128, i32)]>,
}

impl IdeaDates {
    pub(super) fn prepare(source: &Source, run: u32) -> io::Result<Option<Arc<Preparation>>> {
        let replay = source.replay();
        let variables = source.state::<VariableDates>();
        let variable_build = VariableDates::prepare(&variables, Arc::clone(&replay), run)?;
        let state = source.state::<IdeaDates>();
        let mut held = state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((ready, _)) = held.runs.get(&run) { return ready.pending(); }
        if held.bytes + RUN_BYTES > RETAINED_BYTES { return Ok(variable_build); }
        let ready = Arc::<Preparation>::default();
        if !held.building {
            let state = Arc::clone(&state);
            if read_ahead::spawn("idea proof dates", move || Self::build(&state, &replay, &variables)).is_err() {
                return Ok(variable_build);
            }
            held.building = true;
        }
        held.bytes += RUN_BYTES;
        held.runs.insert(run, (Arc::clone(&ready), None));
        ready.pending()
    }

    fn build(state: &Mutex<Self>, replay: &Arc<Replay>, variables: &Arc<Mutex<VariableDates>>) {
        job_priority::background_thread();
        loop {
            let (run, ready, budget) = {
                let mut held = state.lock().unwrap_or_else(PoisonError::into_inner);
                let Some((&run, (ready, _))) = held.runs.iter().find(|(_, (ready, _))| ready.result().is_none()) else {
                    held.building = false;
                    return;
                };
                (run, Arc::clone(ready), RETAINED_BYTES - held.bytes)
            };
            ready.run(|| {
                let run_info = replay.recording().run(run)?;
                let span = (run_info.first_hour, run_info.last_hour());
                let mut dates = RunDates { span, tables: Vec::with_capacity(SPECS.len()) };
                let mut bytes = 0;
                for spec in SPECS {
                    if let Some(table) = spec.load(replay, run, span, budget - bytes) {
                        bytes += table.bytes();
                        dates.tables.push(table);
                    }
                }
                let mut held = state.lock().unwrap_or_else(PoisonError::into_inner);
                if bytes <= RETAINED_BYTES - held.bytes {
                    held.bytes += bytes;
                    held.runs.get_mut(&run).expect("admitted idea run").1 = Some(Arc::new(dates));
                }
                drop(held);
                if let Some(variable_build) = VariableDates::prepare(variables, Arc::clone(replay), run)? {
                    variable_build.wait()?;
                }
                Ok(())
            });
        }
    }

    pub(super) fn get(&self, run: u32, span: (i32, i32)) -> Option<Arc<RunDates>> {
        self.runs.get(&run)?.1.as_ref().filter(|dates| dates.span == span).cloned()
    }
}

impl Spec {
    fn load(&self, replay: &Replay, run: u32, (first, last): (i32, i32), budget: usize) -> Option<TableDates> {
        let recording = replay.recording();
        let index = self.table.index();
        let columns: Vec<_> = (0..64).filter(|&column| self.fields & (1 << column) != 0).collect();
        let available = recording.read_columns(index);
        if !matches!(recording.table_coverage(index, run), TableCoverage::Valid)
            || columns.iter().any(|column| !available.contains(column))
            || self.shift.is_some() && dashboard_declare::summaries().ok()?.iter()
                .any(|(table, shape)| *table == index && !matches!(shape, Shape::Log(_)))
        {
            return None;
        }
        if self.shift.is_some() {
            let span = recording.run(run).ok()?;
            for block in 0..(span.pages() as u32).saturating_sub(1) {
                if recording.table_entry(run, block, index).ok()?.unit.restore.is_some() {
                    let hour = span.block_first_hour(block + 1);
                    cells(recording, run, self.table, &columns, Keys::These(&[]), hour, hour, None,
                        &mut |_, _, _| true).ok()?;
                }
            }
        }
        let mut statuses = Vec::new();
        let mut changes = Vec::new();
        let mut overflow = false;
        let limit = budget / size_of::<(u128, i32)>();
        cells(recording, run, self.table, &columns, Keys::All, first, last, Some(&mut statuses), &mut |hour, key, _| {
            let group = self.shift.map_or(0, |shift| key >> shift);
            if hour != first && changes.last() != Some(&(group, hour)) {
                if changes.len() == limit {
                    overflow = true;
                    return false;
                }
                changes.push((group, hour));
            }
            true
        }).ok()?;
        if overflow { return None; }
        status_reasons(recording, run, self.table, &statuses).ok()?;
        changes.sort_unstable();
        changes.dedup();
        let dates = TableDates {
            table: self.table, fields: self.fields, shift: self.shift,
            statuses: statuses.into_iter().map(|status| status.first).collect(),
            changes: changes.into_boxed_slice(),
        };
        (dates.bytes() <= budget).then_some(dates)
    }
}

impl RunDates {
    pub(super) fn next(&self, table: TableId, selection: &Selection, hour: i32) -> Option<Option<i32>> {
        self.tables.iter().find(|dates| dates.table == table)?.next(selection, hour)
    }
}

impl TableDates {
    fn bytes(&self) -> usize { size_of_val(&*self.statuses) + size_of_val(&*self.changes) }

    fn next(&self, selection: &Selection, hour: i32) -> Option<Option<i32>> {
        if selection.fields != self.fields || selection.ends { return None; }
        let changes = match selection.rows.as_deref() {
            None => self.changes.iter().filter_map(|&(_, date)| (date > hour).then_some(date)).min(),
            Some(ranges) => {
                let shift = self.shift?;
                let mask = (1_u128 << shift) - 1;
                if ranges.iter().any(|&(lo, hi)| lo & mask != 0 || hi & mask != mask) { return None; }
                ranges.iter().filter_map(|&(lo, hi)| {
                    let start = self.changes.partition_point(|&(key, _)| key < lo >> shift);
                    let end = self.changes.partition_point(|&(key, _)| key <= hi >> shift);
                    self.changes[start..end].iter().filter_map(|&(_, date)| (date > hour).then_some(date)).min()
                }).min()
            }
        };
        let status = self.statuses.get(self.statuses.partition_point(|&date| date <= hour)).copied();
        Some(changes.into_iter().chain(status).min())
    }
}
