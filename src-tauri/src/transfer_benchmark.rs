//! Opt-in local-disk benchmark of the native worker and foreground metadata reads.
use super::*;
use std::{io::Write, sync::mpsc, time::Duration};

const MIB: usize = 1024 * 1024;
const LARGE_MIB: usize = 256;
const SMALL_FILES: usize = 1_000;

fn browse(directory: &Path) -> (Duration, Duration) {
    let start = Instant::now();
    let mut first = None;
    let listing = directory_listing::read(directory, &AtomicBool::new(false), |_| {
        first.get_or_insert_with(|| start.elapsed());
        true
    })
    .unwrap()
    .unwrap();
    assert_eq!(listing.entries.len(), 10_000);
    (first.unwrap(), start.elapsed())
}

fn report_browsing(label: &str, samples: &[(Duration, Duration)]) {
    if samples.is_empty() {
        eprintln!("{label}: no foreground read overlapped the worker");
        return;
    }
    let mut first: Vec<_> = samples.iter().map(|value| value.0).collect();
    let mut full: Vec<_> = samples.iter().map(|value| value.1).collect();
    first.sort_unstable();
    full.sort_unstable();
    let mid = samples.len() / 2;
    eprintln!(
        "{label}: {} directory reads, median first {:?}, median full {:?}, slowest full {:?}",
        samples.len(),
        first[mid],
        full[mid],
        full.last().unwrap()
    );
}

#[test]
#[ignore = "copies 256 MiB and moves 1,000 files with real recovery journals"]
fn browsing_during_native_transfers() {
    let fixture = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(fixture.path()).unwrap();
    let listing = root.join("browse");
    fs::create_dir(&listing).unwrap();
    for i in 0..10_000 {
        fs::write(listing.join(i.to_string()), b"browse").unwrap();
    }
    let _ = browse(&listing);
    report_browsing(
        "idle",
        &(0..10).map(|_| browse(&listing)).collect::<Vec<_>>(),
    );

    for kind in ["copy", "move"] {
        let shared = Shared::default();
        shared
            .recovery
            .initialize(root.join(format!("{kind}-recovery")), &shared)
            .unwrap();
        let source = root.join(format!("{kind}-source"));
        let target = root.join(format!("{kind}-target"));
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        let bytes = vec![0x5au8; MIB];
        let paths = if kind == "copy" {
            let path = source.join("large.bin");
            let mut file = fs::File::create(&path).unwrap();
            for _ in 0..LARGE_MIB {
                file.write_all(&bytes).unwrap();
            }
            file.sync_all().unwrap();
            vec![strpath(&path)]
        } else {
            (0..SMALL_FILES)
                .map(|i| {
                    let path = source.join(i.to_string());
                    fs::write(&path, &bytes[..4096]).unwrap();
                    strpath(&path)
                })
                .collect()
        };
        let plan = plan_transfer(kind, &paths, &strpath(&target), None, None, &|| Ok(())).unwrap();
        let id = register_task(
            &shared,
            Task {
                kind: kind.to_owned(),
                status: "running".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let (ready, started) = mpsc::channel();
        let start = Instant::now();
        let mut samples = Vec::new();
        let (first_progress, largest_gap, elapsed) = std::thread::scope(|threads| {
            let worker = threads.spawn(|| {
                let mut ready = Some(ready);
                let mut last = (0, 0);
                let mut changed_at = start;
                let mut first_progress = None;
                let mut largest_gap = Duration::ZERO;
                let mut checkpoint = || {
                    if let Some(sender) = ready.take() {
                        sender.send(()).unwrap();
                    }
                    let tasks = shared.tasks.lock().unwrap();
                    let task = &tasks[&id];
                    let current = (task.bytes, task.completed);
                    if current != last {
                        first_progress.get_or_insert_with(|| start.elapsed());
                        largest_gap = largest_gap.max(changed_at.elapsed());
                        changed_at = Instant::now();
                        last = current;
                    }
                    Ok(())
                };
                execute_transfer_plan(
                    &shared,
                    &id,
                    kind,
                    plan.items,
                    plan.folder,
                    None,
                    &mut checkpoint,
                )
                .unwrap();
                (
                    first_progress,
                    largest_gap.max(changed_at.elapsed()),
                    start.elapsed(),
                )
            });
            started.recv().unwrap();
            while !worker.is_finished() {
                samples.push(browse(&listing));
            }
            worker.join().unwrap()
        });
        report_browsing(kind, &samples);
        eprintln!("{kind} worker elapsed {elapsed:?}, first native progress {first_progress:?}, longest gap {largest_gap:?}");
        let tasks = shared.tasks.lock().unwrap();
        assert!(tasks[&id].errors.is_empty());
        assert_eq!(tasks[&id].completed as usize, paths.len());
        if kind == "copy" {
            let mut buffer = vec![0; MIB];
            for path in [source.join("large.bin"), target.join("large.bin")] {
                let mut file = fs::File::open(path).unwrap();
                assert_eq!(file.metadata().unwrap().len(), (MIB * LARGE_MIB) as u64);
                for _ in 0..LARGE_MIB {
                    file.read_exact(&mut buffer).unwrap();
                    assert_eq!(buffer, bytes);
                }
            }
        } else {
            assert_eq!(fs::read_dir(source).unwrap().count(), 0);
            assert_eq!(fs::read_dir(&target).unwrap().count(), SMALL_FILES);
            for i in 0..SMALL_FILES {
                assert_eq!(
                    fs::read(target.join(i.to_string())).unwrap(),
                    &bytes[..4096]
                );
            }
        }
    }
}
