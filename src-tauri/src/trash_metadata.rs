//! Bounded, read-only reader for Finder's DSDB put-back records. Unknown or
//! damaged stores yield no inferred original path; the trash itself is untouched.
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};
struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(count).ok_or("记录超出范围")?;
        let result = self.data.get(self.at..end).ok_or("记录不完整")?;
        self.at = end;
        Ok(result)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn utf16(&mut self, count: usize) -> Result<String, String> {
        let bytes = self.take(count.checked_mul(2).ok_or("字符串过长")?)?;
        String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(|error| error.to_string())
    }
}
pub(crate) fn read(path: &Path) -> Result<HashMap<String, String>, String> {
    if fs::metadata(path).map_err(|error| error.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("回收站位置记录过大".into());
    }
    parse(&fs::read(path).map_err(|error| error.to_string())?)
}
fn parse(data: &[u8]) -> Result<HashMap<String, String>, String> {
    let mut header = Cursor { data, at: 0 };
    if header.u32()? != 1 || header.take(4)? != b"Bud1" {
        return Err("不是 Finder 位置记录".into());
    }
    let root = header.u32()? as usize;
    let size = header.u32()? as usize;
    if header.u32()? as usize != root {
        return Err("位置记录头无效".into());
    }
    let mut allocator = Cursor {
        data: data
            .get(
                root.checked_add(4).ok_or("偏移无效")?
                    ..root
                        .checked_add(size)
                        .and_then(|end| end.checked_add(4))
                        .ok_or("大小无效")?,
            )
            .ok_or("分配表无效")?,
        at: 0,
    };
    let count = allocator.u32()? as usize;
    allocator.u32()?;
    if count > 1_000_000 {
        return Err("分配表过大".into());
    }
    let addresses = (0..count)
        .map(|_| allocator.u32())
        .collect::<Result<Vec<_>, _>>()?;
    allocator.take(((count + 255) & !255).saturating_sub(count) * 4)?;
    let toc_count = allocator.u32()? as usize;
    if toc_count > 1024 {
        return Err("目录表过大".into());
    }
    let mut superblock = None;
    for _ in 0..toc_count {
        let len = allocator.take(1)?[0] as usize;
        let name = allocator.take(len)?;
        let block = allocator.u32()?;
        if name == b"DSDB" {
            superblock = Some(block);
        }
    }
    fn block<'a>(data: &'a [u8], addresses: &[u32], id: u32) -> Result<Cursor<'a>, String> {
        let address = *addresses.get(id as usize).ok_or("块编号无效")? as usize;
        let start = (address & !31).checked_add(4).ok_or("块偏移无效")?;
        let size = 1usize
            .checked_shl((address & 31) as u32)
            .ok_or("块大小无效")?;
        Ok(Cursor {
            data: data
                .get(start..start.checked_add(size).ok_or("块边界无效")?)
                .ok_or("块不完整")?,
            at: 0,
        })
    }
    let root = block(data, &addresses, superblock.ok_or("缺少 DSDB")?)?.u32()?;
    let mut queue = vec![root];
    let mut seen = HashSet::new();
    let mut locations = HashMap::new();
    let mut names = HashMap::new();
    while let Some(id) = queue.pop() {
        if !seen.insert(id) || seen.len() > addresses.len() {
            return Err("位置记录包含循环".into());
        }
        let mut node = block(data, &addresses, id)?;
        let next = node.u32()?;
        let count = node.u32()?;
        if count > 100_000 {
            return Err("记录数量过大".into());
        }
        if next != 0 {
            queue.push(next);
        }
        for _ in 0..count {
            if next != 0 {
                queue.push(node.u32()?);
            }
            let count = node.u32()? as usize;
            let name = node.utf16(count)?;
            let code = node.take(4)?.to_vec();
            let kind = node.take(4)?.to_vec();
            let text = match kind.as_slice() {
                b"ustr" => {
                    let count = node.u32()? as usize;
                    Some(node.utf16(count)?)
                }
                b"blob" => {
                    let len = node.u32()? as usize;
                    let bytes = node.take(len)?;
                    std::str::from_utf8(bytes)
                        .ok()
                        .map(|text| text.trim_end_matches('\0').to_string())
                }
                b"bool" => {
                    node.take(1)?;
                    None
                }
                b"long" | b"shor" | b"type" => {
                    node.take(4)?;
                    None
                }
                b"comp" | b"dutc" => {
                    node.take(8)?;
                    None
                }
                _ => return Err("位置记录类型未知".into()),
            };
            if let Some(text) = text {
                if code == b"ptbL" {
                    locations.insert(name, text);
                } else if code == b"ptbN" {
                    names.insert(name, text);
                }
            }
        }
    }
    Ok(locations
        .into_iter()
        .filter_map(|(name, folder)| {
            if folder.is_empty() || folder.contains('\0') {
                return None;
            }
            let folder = if folder.starts_with('/') {
                folder
            } else {
                format!("/{folder}")
            };
            let folder = folder
                .strip_prefix("/System/Volumes/Data/")
                .map(|rest| format!("/{rest}"))
                .unwrap_or(folder);
            let original_name = names.get(&name).unwrap_or(&name);
            if crate::valid_name(original_name).is_err()
                || Path::new(&folder)
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
            {
                return None;
            }
            let original = crate::strpath(&Path::new(&folder).join(original_name));
            Some((name, original))
        })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(original_name: &str) -> Vec<u8> {
        fn write_u32(data: &mut [u8], at: usize, value: u32) {
            data[at..at + 4].copy_from_slice(&value.to_be_bytes());
        }
        fn record(code: &[u8], text: &str) -> Vec<u8> {
            let name = "renamed.txt".encode_utf16().collect::<Vec<_>>();
            let value = text.encode_utf16().collect::<Vec<_>>();
            let mut bytes = (name.len() as u32).to_be_bytes().to_vec();
            for ch in name {
                bytes.extend(ch.to_be_bytes());
            }
            bytes.extend(code);
            bytes.extend(b"ustr");
            bytes.extend((value.len() as u32).to_be_bytes());
            for ch in value {
                bytes.extend(ch.to_be_bytes());
            }
            bytes
        }
        let mut data = vec![0; 8196];
        write_u32(&mut data, 0, 1);
        data[4..8].copy_from_slice(b"Bud1");
        write_u32(&mut data, 8, 2048);
        write_u32(&mut data, 12, 2048);
        write_u32(&mut data, 16, 2048);
        write_u32(&mut data, 2052, 3);
        for (index, address) in [2048 | 11, 32 | 5, 4096 | 12].iter().enumerate() {
            write_u32(&mut data, 2060 + index * 4, *address);
        }
        write_u32(&mut data, 3084, 1);
        data[3088] = 4;
        data[3089..3093].copy_from_slice(b"DSDB");
        write_u32(&mut data, 3093, 1);
        write_u32(&mut data, 36, 2);
        write_u32(&mut data, 4104, 2);
        let records = [
            record(b"ptbL", "System/Volumes/Data/Users/test/Documents/"),
            record(b"ptbN", original_name),
        ]
        .concat();
        data[4108..4108 + records.len()].copy_from_slice(&records);
        data
    }
    #[test]
    fn reads_put_back_names_and_normalizes_the_apfs_data_firmlink() {
        assert_eq!(
            parse(&fixture("original.txt"))
                .unwrap()
                .get("renamed.txt")
                .unwrap(),
            "/Users/test/Documents/original.txt"
        );
        assert!(parse(&fixture("../unsafe")).unwrap().is_empty());
    }
    #[test]
    fn malformed_stores_do_not_infer_paths() {
        for bytes in [
            vec![],
            vec![0; 128],
            [1u32.to_be_bytes().as_slice(), b"Bud1", &[255; 28]].concat(),
        ] {
            assert!(parse(&bytes).is_err());
        }
    }
}
