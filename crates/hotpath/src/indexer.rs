//! Workspace walker. Streams files (respecting .gitignore) for chunking
//! and indexing by the Python agent.

use anyhow::Result;
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct FileEntry {
    pub path: String,
    pub bytes: u64,
}

pub fn count_files<P: AsRef<Path>>(root: P) -> Result<usize> {
    let mut n = 0usize;
    for entry in WalkBuilder::new(root).hidden(false).build().flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            n += 1;
        }
    }
    Ok(n)
}

pub fn walk<P: AsRef<Path>>(root: P, max: Option<usize>) -> Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    for entry in WalkBuilder::new(root).hidden(false).build().flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(FileEntry {
            path: entry.path().display().to_string(),
            bytes,
        });
        if let Some(m) = max {
            if out.len() >= m {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn walk_counts_files() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.txt"), "hi").unwrap();
        fs::create_dir(td.path().join("sub")).unwrap();
        fs::write(td.path().join("sub/b.txt"), "yo").unwrap();
        let v = walk(td.path(), None).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(count_files(td.path()).unwrap(), 2);
    }
}
