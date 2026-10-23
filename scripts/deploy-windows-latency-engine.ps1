$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=Join-Path $env:LOCALAPPDATA 'OpenCodexBuild'
$source=Join-Path $root 'engine-hooks1-target\debug'
$target=Join-Path $env:LOCALAPPDATA 'OpenCodex\engines\0.160.0-latency1'
$official=(Get-Command codex).Source
$original=(Get-FileHash -LiteralPath $official -Algorithm SHA256).Hash
$built=Join-Path $source 'codex.exe'
if((Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash -ne '8E31AD30683378CA693234C933A5ED4597C4E646F7B97734CBE0004DD601D3E2'){throw 'Research engine differs from verified latency build'}
$info=[Diagnostics.ProcessStartInfo]::new()
$info.FileName=$built
$info.Arguments='app-server --listen stdio:// -c features.hooks=false -c features.plugin_hooks=false -c features.apps=false'
$info.UseShellExecute=$false
$info.CreateNoWindow=$true
$info.RedirectStandardInput=$true
$info.RedirectStandardOutput=$true
$info.RedirectStandardError=$true
$p=[Diagnostics.Process]::new()
$p.StartInfo=$info
function Receive-Reply($id){
 $deadline=[DateTime]::UtcNow.AddSeconds(45)
 while([DateTime]::UtcNow -lt $deadline){
  $line=$p.StandardOutput.ReadLineAsync()
  if(-not $line.Wait([Math]::Max(1,[int]($deadline-[DateTime]::UtcNow).TotalMilliseconds))){throw 'Engine reply timed out'}
  if($null -eq $line.Result){throw 'Engine stdout closed before reply'}
  $m=$line.Result|ConvertFrom-Json
  if($m.id -eq $id){if($m.error){throw ('Engine RPC error: '+($m.error|ConvertTo-Json -Compress))};return $m.result}
 }
 throw 'Engine reply deadline exceeded'
}
try{
 [void]$p.Start()
 $stderr=$p.StandardError.ReadToEndAsync()
 $p.StandardInput.WriteLine('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"opencodex-engine-qa","version":"0.4.10"},"capabilities":{"experimentalApi":true}}}')
 $p.StandardInput.Flush()
 $init=Receive-Reply 1
 if($init.userAgent -notmatch 'OpenCodexHooks/1' -or $init.userAgent -notmatch 'OpenCodexPermissions/1' -or $init.userAgent -notmatch 'OpenCodexGuardian/1'){throw 'Missing explicit Hooks, permissions or Guardian capability'}
 $p.StandardInput.WriteLine('{"method":"initialized"}')
 $p.StandardInput.WriteLine('{"id":2,"method":"thread/list","params":{"limit":1,"archived":false,"useStateDb":true}}')
 $p.StandardInput.Flush()
 $listed=Receive-Reply 2
 if($null -eq $listed.data){throw 'Existing profile thread/list did not return data'}
 $threadCount=@($listed.data).Count
} finally {
 if(-not $p.HasExited){$p.StandardInput.Close();if(-not $p.WaitForExit(5000)){$p.Kill();$p.WaitForExit()}}
 if($stderr -and $stderr.IsCompleted){$errors=$stderr.Result;if($errors -match 'migration .*modified|migration.*checksum'){throw 'Existing database migration validation failed'}}
 $p.Dispose()
}
$inUse=Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)}
if($inUse){throw 'Dedicated engine still in use; disconnect its OpenCodex session before deployment'}
[void](New-Item -ItemType Directory -Path $target -Force)
$backup=Join-Path $target ('before-latency-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
[void](New-Item -ItemType Directory -Path $backup)
$files=@()
foreach($name in @('codex.exe','codex-code-mode-host.exe')){
 $from=Join-Path $source $name
 $to=Join-Path $target $name
 if(Test-Path -LiteralPath $to){Copy-Item -LiteralPath $to -Destination (Join-Path $backup $name)}
 Copy-Item -LiteralPath $from -Destination $to
 $hash=(Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
 if($hash -ne (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash){throw 'Deployed engine hash mismatch'}
 $files+=[pscustomobject]@{Path=$to;Sha256=$hash;Bytes=(Get-Item -LiteralPath $to).Length}
}
if((Get-FileHash -LiteralPath $official -Algorithm SHA256).Hash -ne $original){throw 'Official executable changed during deployment'}
$version=(& (Join-Path $target 'codex.exe') --version|Out-String).Trim()
if($LASTEXITCODE -ne 0){throw 'Deployed version check failed'}
[pscustomobject]@{Passed=$true;At=[DateTime]::UtcNow.ToString('o');OfficialSha256=$original;OfficialUnchanged=$true;ExistingProfileCompatible=$true;ExistingProfile=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'};HistoryRowsObserved=$threadCount;Capability=$init.userAgent;Version=$version;Files=$files;Backup=$backup}|ConvertTo-Json -Depth 6
