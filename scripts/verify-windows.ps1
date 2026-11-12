<#
.SYNOPSIS
  Checks the Windows release the way an endpoint will see it.

.DESCRIPTION
  Extracts the release zip, then:
    - checks the exe carries version info (CompanyName, FileDescription, ...)
    - reports the Authenticode status (fails with -RequireSigned unless Valid)
    - runs `helmscope.exe -version` and starts the server for a /api/info call
    - scans the extracted files with Microsoft Defender when it is present
      (exit 2 from MpCmdRun = threat found = this script fails)
    - prints the SHA-256 to hand to the security team for allowlisting

  Works on Windows PowerShell 5.1 and PowerShell 7. On a corporate-managed
  runner the endpoint agent (EDR) also sees every step, which is the real test.

.EXAMPLE
  pwsh scripts/verify-windows.ps1 -Zip dist/helmscope_v1.2.3_windows_amd64.zip -RequireSigned
#>
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [switch]$RequireSigned,
  [switch]$SkipSignatureUpdate
)
$ErrorActionPreference = 'Stop'

$zipPath = (Resolve-Path $Zip).Path
$out = Join-Path ([IO.Path]::GetTempPath()) ("helmscope-verify-" + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $zipPath -DestinationPath $out
$exe = (Get-ChildItem -Path $out -Recurse -Filter helmscope.exe | Select-Object -First 1).FullName
if (-not $exe) { throw "helmscope.exe not found in $zipPath" }
Write-Host "exe:        $exe"
Write-Host "sha256:     $((Get-FileHash -Algorithm SHA256 $exe).Hash)"

# Version resource
$vi = (Get-Item $exe).VersionInfo
Write-Host "company:    $($vi.CompanyName)"
Write-Host "product:    $($vi.ProductName) $($vi.ProductVersion)"
Write-Host "describes:  $($vi.FileDescription)"
if (-not $vi.FileDescription -or -not $vi.CompanyName) { throw 'helmscope.exe has no version resource (was windres missing at build time?)' }

# Authenticode
$sig = Get-AuthenticodeSignature -FilePath $exe
Write-Host "signature:  $($sig.Status) $(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject })"
if ($sig.TimeStamperCertificate) { Write-Host "timestamp:  $($sig.TimeStamperCertificate.Subject)" }
if ($RequireSigned -and $sig.Status -ne 'Valid') { throw "Authenticode status is $($sig.Status), expected Valid" }

# Runs at all
$v = & $exe -version
if ($LASTEXITCODE -ne 0) { throw "helmscope.exe -version exited $LASTEXITCODE" }
Write-Host "version:    $v"

# Serves on loopback (no firewall prompt for 127.0.0.1)
$port = Get-Random -Minimum 20000 -Maximum 40000
$p = Start-Process -FilePath $exe -ArgumentList @('-addr', "127.0.0.1:$port", $out) -PassThru -WindowStyle Hidden
try {
  $info = $null
  foreach ($i in 1..20) {
    try { $info = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/info" -TimeoutSec 2; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $info) { throw 'server did not answer /api/info' }
  Write-Host "api/info:   version=$($info.version) root=$($info.root)"
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}

# Microsoft Defender
$mp = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
if (-not (Test-Path $mp)) {
  Write-Warning 'Microsoft Defender (MpCmdRun.exe) is not available; skipping the AV scan'
} else {
  if (-not $SkipSignatureUpdate) {
    & $mp -SignatureUpdate | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Warning "Defender signature update exited $LASTEXITCODE; scanning with current signatures" }
  }
  & $mp -Scan -ScanType 3 -File $out -DisableRemediation | Out-Host
  switch ($LASTEXITCODE) {
    0 { Write-Host 'defender:   no threats found' }
    2 { throw 'Microsoft Defender flagged the release; see the scan output above' }
    default { Write-Warning "MpCmdRun exited $LASTEXITCODE; the scan was inconclusive (Defender may be disabled on this machine)" }
  }
}

Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
exit 0
