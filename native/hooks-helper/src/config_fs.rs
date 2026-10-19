// Read-only adapter for the upstream config loader, not a tool filesystem.
use codex_file_system::*;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use std::io;

pub struct ConfigFileSystem;
fn unsupported<T>() -> io::Result<T> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "operation is unavailable in the read-only config filesystem"))
}
fn check(sandbox: Option<&FileSystemSandboxContext>) -> io::Result<()> {
    if sandbox.is_some() { return unsupported(); }
    Ok(())
}
fn millis(time: io::Result<std::time::SystemTime>) -> i64 {
    time.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|v| v.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0)
}
impl ExecutorFileSystem for ConfigFileSystem {
    fn canonicalize<'a>(&'a self, path: &'a PathUri, sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, PathUri> {
        Box::pin(async move {
            check(sandbox)?;
            let path = tokio::fs::canonicalize(path.to_abs_path()?.as_path()).await?;
            Ok(PathUri::from_abs_path(&AbsolutePathBuf::try_from(path)?))
        })
    }
    fn read_file<'a>(&'a self, path: &'a PathUri, options: ReadFileOptions, sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        Box::pin(async move {
            check(sandbox)?;
            let path = path.to_abs_path()?;
            if !options.follow_symlinks && tokio::fs::symlink_metadata(path.as_path()).await?.file_type().is_symlink() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "symlink reads disabled"));
            }
            tokio::fs::read(path.as_path()).await
        })
    }
    fn get_metadata<'a>(&'a self, path: &'a PathUri, options: GetMetadataOptions, sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        Box::pin(async move {
            check(sandbox)?;
            let path = path.to_abs_path()?;
            let m = if options.follow_symlinks { tokio::fs::metadata(path.as_path()).await? }
                else { tokio::fs::symlink_metadata(path.as_path()).await? };
            Ok(FileMetadata { is_directory: m.is_dir(), is_file: m.is_file(), is_symlink: m.file_type().is_symlink(),
                size: m.len(), created_at_ms: millis(m.created()), modified_at_ms: millis(m.modified()) })
        })
    }
    fn read_directory<'a>(&'a self, path: &'a PathUri, sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>> {
        Box::pin(async move {
            check(sandbox)?;
            let mut dir = tokio::fs::read_dir(path.to_abs_path()?.as_path()).await?;
            let mut entries = Vec::new();
            while let Some(entry) = dir.next_entry().await? {
                let ft = entry.file_type().await?;
                entries.push(ReadDirectoryEntry { file_name: entry.file_name().to_string_lossy().into_owned(),
                    is_directory: ft.is_dir(), is_file: ft.is_file() });
            }
            Ok(entries)
        })
    }
    fn read_file_stream<'a>(&'a self, _: &'a PathUri, _: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, FileSystemReadStream> { Box::pin(async { unsupported() }) }
    fn write_file<'a>(&'a self, _: &'a PathUri, _: Vec<u8>, _: WriteFileOptions, _: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> { Box::pin(async { unsupported() }) }
    fn create_directory<'a>(&'a self, _: &'a PathUri, _: CreateDirectoryOptions, _: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> { Box::pin(async { unsupported() }) }
    fn walk<'a>(&'a self, _: &'a PathUri, _: WalkOptions, _: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, WalkOutcome> { Box::pin(async { unsupported() }) }
    fn remove<'a>(&'a self, _: &'a PathUri, _: RemoveOptions, _: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> { Box::pin(async { unsupported() }) }
    fn copy<'a>(&'a self, _: &'a PathUri, _: &'a PathUri, _: CopyOptions, _: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> { Box::pin(async { unsupported() }) }
}
