#Requires -Version 5.1
<#
.SYNOPSIS
    umans-gate Windows installer (PowerShell).

.DESCRIPTION
    Zero-devops installer for umans-gate. Detects the host architecture
    (x86_64 or aarch64), queries the latest GitHub Release for
    codegiveness/umans-gate, downloads the matching .zip asset, extracts
    umans-gate.exe to $env:LOCALAPPDATA\Programs\umans-gate (override with
    -InstallDir), adds the install directory to the user PATH if needed,
    and verifies by running umans-gate --version.

    No admin elevation is required. Designed to work both as a local script
    and when piped via irm | iex.

.PARAMETER InstallDir
    Destination directory. Defaults to $env:LOCALAPPDATA\Programs\umans-gate.

.EXAMPLE
    PS> irm https://raw.githubusercontent.com/codegiveness/umans-gate/main/install.ps1 | iex

.EXAMPLE
    PS> .\install.ps1 -InstallDir "C:\Tools\umans-gate"
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\umans-gate"
)

$ErrorActionPreference = "Stop"
$repo = "codegiveness/umans-gate"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Fail {
    param([string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
}

# 1. Detect Windows architecture and map to a cargo-dist target.
#    PROCESSOR_ARCHITEW6432 holds the real arch when running a 32-bit process
#    under WOW64; otherwise PROCESSOR_ARCHITECTURE is authoritative.
$procArch = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrEmpty($procArch)) {
    $procArch = $env:PROCESSOR_ARCHITECTURE
}
if ($procArch -and $procArch.ToUpper().StartsWith("ARM")) {
    $target = "aarch64-pc-windows-msvc"
} else {
    $target = "x86_64-pc-windows-msvc"
}
Write-Step "Detected host architecture: $target"

# 2. Fetch latest release metadata from the GitHub API.
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"
Write-Step "Querying latest release of $repo ..."
try {
    $release = Invoke-RestMethod -Uri $apiUrl `
        -Headers @{ "User-Agent" = "umans-gate-installer" } `
        -ErrorAction Stop
} catch {
    Write-Fail "Failed to fetch release metadata from GitHub: $($_.Exception.Message)"
    exit 1
}

$version = $release.tag_name
if ([string]::IsNullOrEmpty($version)) {
    Write-Fail "Release response did not contain a tag_name; cannot determine version."
    exit 1
}
Write-Host "Latest release: $version"

# 3. Find the .zip asset matching the detected architecture.
$assetName = "umans-gate-$target.zip"
$asset = $release.assets |
    Where-Object { $_.name -eq $assetName } |
    Select-Object -First 1
if (-not $asset) {
    Write-Fail "No release asset named '$assetName' was found for release $version."
    Write-Host "Available assets:" -ForegroundColor Yellow
    $release.assets | ForEach-Object { Write-Host "  - $($_.name)" }
    exit 1
}
Write-Step "Downloading $($asset.name) ..."

# 4. Handle existing installation: upgrade by overwriting.
$exePath = Join-Path $InstallDir "umans-gate.exe"
if (Test-Path $exePath) {
    Write-Host "Existing umans-gate installation found at $InstallDir; upgrading by overwriting." -ForegroundColor Yellow
}

# 5. Download to a temp file and extract.
$tmp = New-TemporaryFile
try {
    try {
        Invoke-WebRequest -Uri $asset.browser_download_url `
            -OutFile $tmp.FullName -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Fail "Failed to download $($asset.name): $($_.Exception.Message)"
        exit 1
    }

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    try {
        Expand-Archive -Path $tmp.FullName -DestinationPath $InstallDir -Force -ErrorAction Stop
    } catch {
        Write-Fail "Failed to extract archive to $InstallDir : $($_.Exception.Message)"
        Write-Host "If umans-gate.exe is running, stop it and re-run the installer." -ForegroundColor Yellow
        exit 1
    }
} finally {
    Remove-Item -Path $tmp.FullName -Force -ErrorAction SilentlyContinue
}

# 6. Confirm the binary landed where we expect.
if (-not (Test-Path $exePath)) {
    Write-Fail "Archive extracted but umans-gate.exe was not found at $exePath."
    Write-Host "Inspect $InstallDir to see what was extracted." -ForegroundColor Yellow
    exit 1
}

# 7. Add the install directory to the user PATH if it is not already present.
#    Uses the User scope so no admin elevation is required.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = if ($userPath) { $userPath -split ';' } else { @() }
$pathEntries = $pathEntries | Where-Object { $_ -ne '' } | ForEach-Object { $_.TrimEnd('\') }
$installDirNorm = $InstallDir.TrimEnd('\')
$onPath = $pathEntries | Where-Object { $_ -ieq $installDirNorm }
if (-not $onPath) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) {
        $InstallDir
    } else {
        "$userPath;$InstallDir"
    }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    # Also update the current session so verification works immediately.
    if (-not ($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $installDirNorm })) {
        $env:Path += ";$InstallDir"
    }
    Write-Step "Added $InstallDir to the user PATH (open a new shell to pick it up)."
} else {
    Write-Host "$InstallDir is already on the user PATH." -ForegroundColor DarkGray
}

# 8. Verify by running umans-gate --version.
try {
    $installed = (& $exePath --version 2>&1) -join "`n"
} catch {
    $installed = ""
}
if ([string]::IsNullOrEmpty($installed)) {
    Write-Fail "umans-gate.exe is present at $exePath but did not respond to --version."
    exit 1
}
$installed = ($installed -split "`n")[0].Trim()

# 9. Print a friendly success message.
Write-Host ""
Write-Host "Installed umans-gate $installed -> $exePath" -ForegroundColor Green
Write-Host ""
Write-Host "Start it with:" -ForegroundColor Cyan
Write-Host "    umans-gate"
Write-Host ""
Write-Host "If 'umans-gate' is not found, open a new shell or run:" -ForegroundColor DarkGray
Write-Host "    & '$exePath'"
