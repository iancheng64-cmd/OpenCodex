$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$root=Join-Path $env:LOCALAPPDATA 'OpenCodexBuild'
$vs=Join-Path $root 'VS2022'
Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
$env:CARGO_HOME=Join-Path $root 'cargo'
$env:RUSTUP_HOME=Join-Path $root 'rustup'
$env:CARGO_TARGET_DIR=Join-Path $root 'engine-hooks1-target'
$env:CARGO_PROFILE_DEV_DEBUG='0'
$env:CARGO_INCREMENTAL='false'
$env:CARGO_NET_GIT_FETCH_WITH_CLI='true'
$env:PATH=(Join-Path $env:CARGO_HOME 'bin')+';C:\Program Files\Git\cmd;'+(Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin')+';'+$env:PATH
$env:RUSTY_V8_ARCHIVE=Join-Path $root 'v8-150.4.0\rusty_v8_ptrcomp_sandbox_release_x86_64-pc-windows-msvc.lib.gz'
$env:RUSTY_V8_SRC_BINDING_PATH=Join-Path $root 'v8-150.4.0\src_binding_ptrcomp_sandbox_release_x86_64-pc-windows-msvc.rs'
Set-Location (Join-Path $root 'engine-hooks1\codex-rust-v0.160.0\codex-rs')
[pscustomobject]@{Stage='build-start';Time=[DateTime]::UtcNow.ToString('o');Compiler=(Get-Command cl.exe).Source;CMake=(Get-Command cmake.exe).Source;Target=$env:CARGO_TARGET_DIR}|ConvertTo-Json -Compress
# Windows official sqlx migration checksums use Git's CRLF checkout.
# Preserve SQL text and match its line endings; never edit existing databases.
$utf8=[Text.UTF8Encoding]::new($false)
$changed=0
foreach($folder in @('migrations','logs_migrations','goals_migrations','memory_migrations','queue_migrations','thread_history_migrations')){
 foreach($file in Get-ChildItem -LiteralPath (Join-Path 'state' $folder) -Filter '*.sql'){
  $text=[IO.File]::ReadAllText($file.FullName)
  $normalized=$text.Replace("`r`n","`n").Replace("`n","`r`n")
  if($text -cne $normalized){[IO.File]::WriteAllText($file.FullName,$normalized,$utf8);$changed++}
 }
}
if($changed -gt 0){(Get-Item 'state\src\migrations.rs').LastWriteTime=Get-Date}
[pscustomobject]@{Stage='windows-sql-line-endings';Changed=$changed;Format='CRLF'}|ConvertTo-Json -Compress
& cargo +1.95.0 build --locked -p codex-cli --bin codex -p codex-code-mode-host --bin codex-code-mode-host -j 4
if($LASTEXITCODE -ne 0){throw ('Windows engine build failed: '+$LASTEXITCODE)}
foreach($name in @('codex.exe','codex-code-mode-host.exe')){
$f=Join-Path $env:CARGO_TARGET_DIR ('debug\'+$name)
[pscustomobject]@{Stage='built';File=$f;Bytes=(Get-Item $f).Length;Sha256=(Get-FileHash $f -Algorithm SHA256).Hash}|ConvertTo-Json -Compress
}
& (Join-Path $env:CARGO_TARGET_DIR 'debug\codex.exe') --version
if($LASTEXITCODE -ne 0){throw 'Built engine version check failed'}
