//! Recreate source holes after CopyFileExW has copied the file and its streams.
//! Sparse-copy flags belong to newer copy APIs and are rejected by CopyFileExW.
use std::{
    ffi::c_void,
    fs::File,
    mem::{size_of, size_of_val},
    os::windows::io::AsRawHandle,
};
use windows_sys::Win32::{
    Foundation::ERROR_MORE_DATA,
    System::{
        Ioctl::{
            FILE_ALLOCATED_RANGE_BUFFER, FILE_ZERO_DATA_INFORMATION, FSCTL_QUERY_ALLOCATED_RANGES,
            FSCTL_SET_SPARSE, FSCTL_SET_ZERO_DATA,
        },
        IO::DeviceIoControl,
    },
};

pub(crate) fn restore(
    source: &File,
    target: &File,
    length: u64,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check()?;
    let length = i64::try_from(length).map_err(|_| "稀疏文件大小超出支持范围")?;
    let mut returned = 0;
    if unsafe {
        DeviceIoControl(
            target.as_raw_handle(),
            FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(format!(
            "无法保留目标稀疏属性，已保留源项目：{}",
            std::io::Error::last_os_error()
        ));
    }
    let zero = |start: i64, end: i64| -> Result<(), String> {
        if start >= end {
            return Ok(());
        }
        check()?;
        let range = FILE_ZERO_DATA_INFORMATION {
            FileOffset: start,
            BeyondFinalZero: end,
        };
        let mut returned = 0;
        if unsafe {
            DeviceIoControl(
                target.as_raw_handle(),
                FSCTL_SET_ZERO_DATA,
                &range as *const _ as *const c_void,
                size_of::<FILE_ZERO_DATA_INFORMATION>() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    };
    let mut offset = 0;
    while offset < length {
        check()?;
        let request = FILE_ALLOCATED_RANGE_BUFFER {
            FileOffset: offset,
            Length: length - offset,
        };
        let mut ranges = [FILE_ALLOCATED_RANGE_BUFFER::default(); 128];
        let mut returned = 0;
        let success = unsafe {
            DeviceIoControl(
                source.as_raw_handle(),
                FSCTL_QUERY_ALLOCATED_RANGES,
                &request as *const _ as *const c_void,
                size_of::<FILE_ALLOCATED_RANGE_BUFFER>() as u32,
                ranges.as_mut_ptr() as *mut c_void,
                size_of_val(&ranges) as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        let error = (success == 0).then(std::io::Error::last_os_error);
        let more = error
            .as_ref()
            .is_some_and(|error| error.raw_os_error() == Some(ERROR_MORE_DATA as i32));
        if let Some(error) = error.filter(|_| !more) {
            return Err(error.to_string());
        }
        if returned as usize > size_of_val(&ranges)
            || returned as usize % size_of::<FILE_ALLOCATED_RANGE_BUFFER>() != 0
        {
            return Err("源稀疏文件返回的分配范围无效".into());
        }
        let before = offset;
        for range in &ranges[..returned as usize / size_of::<FILE_ALLOCATED_RANGE_BUFFER>()] {
            let end = range
                .FileOffset
                .checked_add(range.Length)
                .filter(|_| range.FileOffset >= 0 && range.Length > 0)
                .ok_or("源稀疏文件返回的分配范围无效")?
                .min(length);
            zero(offset, range.FileOffset.min(length))?;
            offset = offset.max(end);
        }
        if !more {
            zero(offset, length)?;
            break;
        }
        if offset <= before {
            return Err("无法继续读取源稀疏文件分配范围".into());
        }
    }
    check()
}
