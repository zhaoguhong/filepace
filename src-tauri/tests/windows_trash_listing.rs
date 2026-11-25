#![cfg(windows)]

use std::{fs, process::Command};
use trash::os_limited;

#[test]
fn worker_lists_a_recycled_folder_with_its_original_name_and_leaves_its_contents_intact() {
    let root = tempfile::tempdir().unwrap();
    let folder = dunce::canonicalize(root.path()).unwrap().join("目录样本");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("nested.txt"), b"fixture bytes").unwrap();
    trash::delete(&folder).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_filepace"))
        .arg("--list-windows-trash")
        .output()
        .unwrap();
    assert!(!folder.exists());
    let fixture = os_limited::list()
        .unwrap()
        .into_iter()
        .find(|item| item.original_path() == folder)
        .unwrap();
    os_limited::restore_all([fixture]).unwrap();
    assert_eq!(
        fs::read(folder.join("nested.txt")).unwrap(),
        b"fixture bytes"
    );

    assert!(output.status.success());
    let (rows, _) =
        serde_json::from_slice::<Result<(Vec<serde_json::Value>, Vec<String>), String>>(
            &output.stdout,
        )
        .unwrap()
        .unwrap();
    let row = rows
        .iter()
        .map(|entry| &entry["item"])
        .find(|item| item["originalPath"].as_str() == folder.to_str())
        .unwrap();
    assert_eq!(row["name"], "目录样本");
    assert_eq!(row["isDir"], true);
    assert!(row["size"].is_null());
}
