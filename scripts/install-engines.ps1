<#
.SYNOPSIS
  Explicit engine installer for dsh-whale-sight.

.DESCRIPTION
  Nothing is downloaded unless you pass -FFmpeg or -YtDlp.

  Every archive is checked against the SHA-256 that its GitHub release publishes
  (`digest` in the release API) before anything is unpacked. A mismatch aborts
  and deletes the download; nothing is installed silently and no admin rights
  are requested.

  ffmpeg is not bundled with this plugin. This script only fetches a known build
  for you, prints where it came from and which licence it carries, and tells you
  how to point the plugin at it.

.PARAMETER FFmpeg
  Download a Windows ffmpeg/ffprobe build (LGPL, shared) into -Dest.

.PARAMETER YtDlp
  Download yt-dlp.exe (optional; only needed for non-Bilibili URLs).

.PARAMETER DryRun
  Print the plan and the size, download nothing.

.PARAMETER Dest
  Where engines are stored. Default: %LOCALAPPDATA%\dsh-whale-sight\engines

.EXAMPLE
  .\install-engines.ps1
  .\install-engines.ps1 -FFmpeg
  .\install-engines.ps1 -FFmpeg -YtDlp
#>
[CmdletBinding()]
param(
  [switch]$FFmpeg,
  [switch]$YtDlp,
  [switch]$DryRun,
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'dsh-whale-sight\engines')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:OS -ne 'Windows_NT') {
  throw 'install-engines.ps1 supports Windows only. On other systems install ffmpeg with your package manager.'
}

function Write-Head([string]$text) { Write-Host ''; Write-Host $text; Write-Host ('-' * $text.Length) }

function Find-Command([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Get-Release([string]$repo) {
  $headers = @{
    'User-Agent' = 'dsh-whale-sight-install-engines'
    'Accept'     = 'application/vnd.github+json'
  }
  return Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 60
}

function Select-Asset($release, [string]$pattern) {
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { throw "No asset matching '$pattern' in $($release.tag_name)." }
  if (-not $asset.digest -or $asset.digest -notmatch '^sha256:([0-9a-fA-F]{64})$') {
    throw "Asset $($asset.name) has no sha256 digest published by GitHub. Refusing to download it."
  }
  return [pscustomobject]@{
    Name   = $asset.name
    Url    = $asset.browser_download_url
    Sha256 = $Matches[1].ToLowerInvariant()
    Size   = $asset.size
    Tag    = $release.tag_name
  }
}

function Save-Verified($asset) {
  if ($DryRun) {
    Write-Host ('  [dry-run] would download {0} ({1:N1} MB) from {2}' -f $asset.Name, ($asset.Size / 1MB), $asset.Tag)
    return $null
  }
  $downloads = Join-Path $Dest 'downloads'
  New-Item -ItemType Directory -Path $downloads -Force | Out-Null
  $target = Join-Path $downloads $asset.Name

  if (Test-Path -LiteralPath $target) {
    $cached = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cached -eq $asset.Sha256) {
      Write-Host '  using cached download (sha256 ok)'
      return $target
    }
    Remove-Item -LiteralPath $target -Force
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) $asset.Name
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  Write-Host ('  downloading {0} ({1:N1} MB)...' -f $asset.Name, ($asset.Size / 1MB))
  Invoke-WebRequest -Uri $asset.Url -OutFile $tmp -UseBasicParsing
  $actual = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $asset.Sha256) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw "Checksum mismatch for $($asset.Name): expected $($asset.Sha256), got $actual. Nothing was installed."
  }
  Write-Host '  sha256 ok'
  Move-Item -LiteralPath $tmp -Destination $target -Force
  return $target
}

function Install-FFmpeg {
  Write-Head 'ffmpeg / ffprobe'
  $release = Get-Release 'BtbN/FFmpeg-Builds'
  $asset = Select-Asset $release '-win64-lgpl-shared.*\.zip$'
  Write-Host ('  release: {0}  asset: {1}' -f $asset.Tag, $asset.Name)
  Write-Host '  licence: LGPL build (no GPL-only components). See the LICENSE file inside the archive.'
  $zip = Save-Verified $asset
  if ($DryRun) { return }

  $outDir = Join-Path $Dest 'ffmpeg'
  $extractTmp = Join-Path $Dest 'ffmpeg.tmp'
  if (Test-Path -LiteralPath $extractTmp) { Remove-Item -LiteralPath $extractTmp -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $extractTmp -Force
  $found = Get-ChildItem -LiteralPath $extractTmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  if (-not $found) { throw 'The archive did not contain ffmpeg.exe.' }
  $buildRoot = $found.Directory.Parent
  if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
  Move-Item -LiteralPath $buildRoot.FullName -Destination $outDir
  Remove-Item -LiteralPath $extractTmp -Recurse -Force -ErrorAction SilentlyContinue

  $bin = Join-Path $outDir 'bin\ffmpeg.exe'
  $probe = Join-Path $outDir 'bin\ffprobe.exe'
  if (-not (Test-Path -LiteralPath $bin) -or -not (Test-Path -LiteralPath $probe)) {
    throw "Expected engines\ffmpeg\bin\ffmpeg.exe after extraction, got: $outDir"
  }

  Write-Host ('  installed: {0}' -f (Join-Path $outDir 'bin'))
  $version = & $bin -version 2>$null | Select-Object -First 1
  if ($version) { Write-Host ('  version: {0}' -f $version) }
  @(
    'ffmpeg  = ' + $bin
    'ffprobe = ' + $probe
    'source  = https://github.com/BtbN/FFmpeg-Builds/releases/' + $asset.Tag
    'licence = LGPL (see LICENSE.txt next to the executables)'
  ) | Set-Content -LiteralPath (Join-Path $Dest 'engines.txt') -Encoding utf8
}

function Install-YtDlp {
  Write-Head 'yt-dlp'
  $release = Get-Release 'yt-dlp/yt-dlp'
  $asset = Select-Asset $release '^yt-dlp\.exe$'
  Write-Host ('  release: {0}  asset: {1}' -f $asset.Tag, $asset.Name)
  Write-Host '  licence: Unlicense (public domain). Only needed for non-Bilibili URLs.'
  $exe = Save-Verified $asset
  if ($DryRun) { return }
  Move-Item -LiteralPath $exe -Destination (Join-Path $Dest 'yt-dlp.exe') -Force
  Write-Host ('  installed: {0}' -f (Join-Path $Dest 'yt-dlp.exe'))
}

function Show-Status {
  Write-Head 'current state'
  $localFfmpeg = Join-Path (Join-Path $Dest 'ffmpeg') 'bin\ffmpeg.exe'
  $localProbe = Join-Path (Join-Path $Dest 'ffmpeg') 'bin\ffprobe.exe'
  $localYtdlp = Join-Path $Dest 'yt-dlp.exe'
  if (-not (Test-Path -LiteralPath $localFfmpeg)) { $localFfmpeg = $null; $localProbe = $null }
  if (-not (Test-Path -LiteralPath $localYtdlp)) { $localYtdlp = $null }
  $rows = @(
    @{ Name = 'ffmpeg (PATH)';   Value = (Find-Command 'ffmpeg') },
    @{ Name = 'ffprobe (PATH)';  Value = (Find-Command 'ffprobe') },
    @{ Name = 'DSH_FFMPEG';      Value = $env:DSH_FFMPEG },
    @{ Name = 'DSH_FFPROBE';     Value = $env:DSH_FFPROBE },
    @{ Name = 'yt-dlp (PATH)';   Value = (Find-Command 'yt-dlp.exe') },
    @{ Name = 'installed here';  Value = $localFfmpeg },
    @{ Name = 'yt-dlp here';     Value = $localYtdlp }
  )
  foreach ($row in $rows) {
    $value = if ($row.Value) { $row.Value } else { '(not found)' }
    Write-Host ('  {0,-16} {1}' -f $row.Name, $value)
  }
  if ($localProbe) { Write-Host ('  ffprobe (here)   {0}' -f $localProbe) }
}

function Show-NextSteps {
  Write-Head 'next steps'
  Write-Host '  Point the plugin at the downloaded executables, either in the profile'
  Write-Host '  config (cordis.patch.yml) or through environment variables:'
  Write-Host ''
  Write-Host ('    ffmpegPath:  {0}' -f (Join-Path $Dest 'ffmpeg\bin\ffmpeg.exe'))
  Write-Host ('    ffprobePath: {0}' -f (Join-Path $Dest 'ffmpeg\bin\ffprobe.exe'))
  Write-Host ''
  Write-Host '  Restart DSH after changing the config.'
}

Write-Host 'dsh-whale-sight engine installer'
if ($DryRun) { Write-Host '(dry run: nothing will be downloaded)' }

if (-not $FFmpeg -and -not $YtDlp) {
  Show-Status
  Write-Host ''
  Write-Host 'Nothing downloaded. Add -FFmpeg and/or -YtDlp when you want them:'
  Write-Host '  .\install-engines.ps1 -FFmpeg'
  Write-Host '  .\install-engines.ps1 -FFmpeg -YtDlp'
  exit 0
}

if (-not $DryRun) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }

if ($FFmpeg) { Install-FFmpeg }
if ($YtDlp) { Install-YtDlp }

if (-not $DryRun) { Show-Status }
Show-NextSteps
