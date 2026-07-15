param(
  [ValidateSet("dir", "nsis")]
  [string]$Target = "nsis"
)

$ErrorActionPreference = "Stop"

$StandaloneRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TempOutput = Join-Path $env:TEMP "habbo-origins-standalone-release"
$ReleaseRoot = Join-Path $StandaloneRoot "release"
$ClientsBackup = Join-Path $env:TEMP "habbo-origins-standalone-clients-backup"

Push-Location $StandaloneRoot
try {
  npm run compile
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  if (Test-Path -LiteralPath $TempOutput) {
    Remove-Item -LiteralPath $TempOutput -Recurse -Force
  }

  npx electron-builder --win $Target --x64 --config.directories.output="$TempOutput"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null

  $SourceUnpacked = Join-Path $TempOutput "win-unpacked"
  if (Test-Path -LiteralPath $SourceUnpacked) {
    $FinalUnpacked = Join-Path $ReleaseRoot "win-unpacked"
    $FinalClients = Join-Path $FinalUnpacked "clients"
    if (Test-Path -LiteralPath $ClientsBackup) {
      Remove-Item -LiteralPath $ClientsBackup -Recurse -Force
    }
    if (Test-Path -LiteralPath $FinalClients) {
      Copy-Item -LiteralPath $FinalClients -Destination $ClientsBackup -Recurse
    }
    if (Test-Path -LiteralPath $FinalUnpacked) {
      Remove-Item -LiteralPath $FinalUnpacked -Recurse -Force
    }
    Copy-Item -LiteralPath $SourceUnpacked -Destination $FinalUnpacked -Recurse
    if (Test-Path -LiteralPath $ClientsBackup) {
      $RestoredClients = Join-Path $FinalUnpacked "clients"
      if (Test-Path -LiteralPath $RestoredClients) {
        Remove-Item -LiteralPath $RestoredClients -Recurse -Force
      }
      Copy-Item -LiteralPath $ClientsBackup -Destination $RestoredClients -Recurse
    }
  }

  if ($Target -eq "nsis") {
    foreach ($Name in @(
      "ShocklessEngine-Standalone-0.1.0-x64.exe",
      "ShocklessEngine-Standalone-0.1.0-x64.exe.blockmap"
    )) {
      $Source = Join-Path $TempOutput $Name
      if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination (Join-Path $ReleaseRoot $Name) -Force
      }
    }
  }

  Write-Host "Standalone Windows $Target build copied to $ReleaseRoot"
} finally {
  Pop-Location
}
