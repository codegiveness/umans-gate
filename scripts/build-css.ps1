#Requires -Version 5.1
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

# Build static/app.css from assets/app.css using the Tailwind CSS v4 standalone CLI.
# No Node.js and no tailwind.config.js required.

$TailwindVersion = "v4.1.0"
$RootDir = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $RootDir "tailwindcss.exe"
$InputFile = Join-Path $RootDir "assets\app.css"
$OutputFile = Join-Path $RootDir "static\app.css"

if (-not (Test-Path $Bin)) {
    Write-Host "Downloading Tailwind CSS ${TailwindVersion} standalone binary (windows-x64)..."
    $Url = "https://github.com/tailwindlabs/tailwindcss/releases/download/${TailwindVersion}/tailwindcss-windows-x64.exe"
    Invoke-WebRequest -Uri $Url -OutFile $Bin -UseBasicParsing
}

$OutputDir = Split-Path -Parent $OutputFile
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

Write-Host "Building ${OutputFile}..."
& $Bin -i $InputFile -o $OutputFile --minify @ExtraArgs
if ($LASTEXITCODE -ne 0) {
    throw "Tailwind build failed with exit code ${LASTEXITCODE}"
}
Write-Host "Done: ${OutputFile}"
