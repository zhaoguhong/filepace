use serde::Serialize;
use std::{collections::HashSet, path::Path};

#[derive(Serialize)]
struct Shortcut {
    name: String,
    path: String,
}
#[derive(Serialize)]
pub(crate) struct Locations {
    places: Vec<Shortcut>,
    skipped: usize,
}

fn resolve(paths: Vec<String>) -> Locations {
    let mut seen = HashSet::new();
    let mut places = Vec::new();
    let mut skipped = 0;
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        match crate::trash_browser::validate_location(path.clone()) {
            Ok(resolved) => {
                let name = Path::new(&path)
                    .file_name()
                    .or_else(|| Path::new(&resolved).file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| resolved.clone());
                places.push(Shortcut {
                    name,
                    path: resolved,
                });
            }
            Err(_) => skipped += 1,
        }
    }
    Locations { places, skipped }
}

#[tauri::command]
pub(crate) async fn resolve_location_shortcuts(paths: Vec<String>) -> Result<Locations, String> {
    tauri::async_runtime::spawn_blocking(move || resolve(paths))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_only_directories_without_moving_or_changing_source_contents() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("project");
        std::fs::create_dir(&folder).unwrap();
        let nested = folder.join("keep.txt");
        std::fs::write(&nested, b"folder bytes stay here").unwrap();
        let file = root.path().join("file.txt");
        std::fs::write(&file, b"ordinary file stays here").unwrap();
        let report = resolve(vec![
            crate::strpath(&folder),
            crate::strpath(&folder),
            crate::strpath(&file),
            crate::strpath(&root.path().join("missing")),
        ]);
        assert_eq!(report.places.len(), 1);
        assert_eq!(report.skipped, 2);
        assert_eq!(
            report.places[0].path,
            crate::strpath(&dunce::canonicalize(&folder).unwrap())
        );
        assert_eq!(report.places[0].name, "project");
        assert_eq!(std::fs::read(&nested).unwrap(), b"folder bytes stay here");
        assert_eq!(std::fs::read(&file).unwrap(), b"ordinary file stays here");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }
}
