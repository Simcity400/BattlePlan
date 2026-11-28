use super::*;
use crate::test_fixtures::{CAMPAIGN, records, source};
use replay_data::rows::{ActiveIdeaRow, TableRows};
use replay_frame::frame::TableView;

fn ideas_recording(last: i32, rows: impl Fn(i32) -> Vec<ActiveIdeaRow>) -> Replay {
    let table = TableId::ActiveIdeas;
    let frames = (100..=last).map(|hour| {
        let mut frame = source(1, hour, Some(1_000));
        frame.tables[table.index()] = TableView::Complete(TableRows::ActiveIdeas(rows(hour))).into();
        frame.metrics.table_ns[table.index()] = 1;
        frame
    }).collect();
    Replay::from_records(recorder_derive::writers(), CAMPAIGN.into(), &[records(1, frames)]).unwrap()
}

#[test]
fn prepared_idea_dates_keep_exact_owner_selections_without_restoring() {
    let table = TableId::ActiveIdeas;
    let replay = ideas_recording(110, |hour| [(1, 103), (2, 105)].into_iter().map(|(country, changed)| ActiveIdeaRow {
        country, ordinal: 0, token: if hour < changed { b"first".to_vec() } else { b"after".to_vec() },
    }).collect());
    let spec = SPECS.iter().find(|spec| spec.table == table).unwrap();
    let dates = spec.load(&replay, 0, (100, 110), RETAINED_BYTES).unwrap();
    for (country, changed) in [(1_u128, 103), (2, 105), (3, 110)] {
        let start = country << 32;
        let selection = Selection { fields: 1, rows: Some(vec![(start, start | u128::from(u32::MAX))]), ends: false };
        let legacy = selection.dates(&replay, 0, table, 100, 110).unwrap();
        let (next, reads) = replay_recording::cells::count_reads(|| dates.next(&selection, 101));
        assert_eq!(next, Some(legacy.into_iter().find(|&hour| hour > 101)));
        assert_eq!(next.flatten().unwrap_or(110), changed);
        assert!(reads.is_empty());
    }
    let narrow = Selection { fields: 1, rows: Some(vec![(1 << 32, 1 << 32)]), ends: false };
    assert_eq!(dates.next(&narrow, 101), None);
    let whole = Selection { fields: 1, rows: None, ends: false };
    assert_eq!(dates.next(&whole, 101), Some(Some(103)));
    assert_eq!(dates.next(&Selection { ends: true, ..whole }, 101), None);
    assert!(spec.load(&replay, 0, (100, 110), 0).is_none());
}

#[test]
fn a_damaged_anchor_refuses_dates_even_when_another_owner_spans_it() {
    use replay_columnar::unit::{BLOCK, restore::column_stream};
    let checkpoint = 100 + 6 * BLOCK as i32;
    let last = checkpoint + 1;
    let full = ideas_recording(last, |hour| [(2, checkpoint - 1), (1, checkpoint)].into_iter()
        .filter(|&(_, from)| hour >= from)
        .map(|(country, _)| ActiveIdeaRow { country, ordinal: 0, token: b"idea".to_vec() }).collect());
    let table = TableId::ActiveIdeas;
    let page = full.recording().table_entry(0, 5, table.index()).unwrap();
    let restore = page.unit.restore.as_ref().unwrap();
    let (_, chunks) = restore.streams.iter().find(|(stream, _)| *stream == column_stream(0)).unwrap();
    let frame = &chunks[0].frame;
    let mut bytes = full.bytes().to_vec();
    bytes[(frame.offset + u64::from(frame.stored) / 2) as usize] ^= 0x80;
    let damaged = Replay::open(bytes).unwrap();
    let range = (1_u128 << 32, (1_u128 << 32) | u128::from(u32::MAX));
    let scoped = Selection { fields: 1, rows: Some(vec![range]), ends: false };
    let spec = SPECS.iter().find(|spec| spec.table == table).unwrap();
    assert!(scoped.dates(&full, 0, table, 100, last).is_ok());
    assert!(scoped.dates(&damaged, 0, table, 100, last).is_err());
    assert!(Selection { rows: None, ..scoped }.dates(&damaged, 0, table, 100, last).is_ok());
    assert!(spec.load(&damaged, 0, (100, last), RETAINED_BYTES).is_none());
}
