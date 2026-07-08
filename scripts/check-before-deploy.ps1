#Requires -Version 5.1
<#
.SYNOPSIS
    Pre-deploy check to prevent duplicate backend creation.
#>

Write-Host "=== ElimuX Backend Pre-Deploy Check ===" -ForegroundColor Cyan

# Check we're in the right directory
$expectedPath = "C:\Users\ELON\Projects-2026\IDEA STORE\elimux-backend"
$currentPath = (Get-Location).Path
if ($currentPath -ne $expectedPath) {
    Write-Error "WRONG DIRECTORY! Expected: $expectedPath"
    Write-Error "Current: $currentPath"
    Write-Error "Are you in the right project?"
    exit 1
}

# Check Railway project
$railwayProject = railway status 2>$null
if ($railwayProject -notmatch "elimux-backend") {
    Write-Error "WRONG RAILWAY PROJECT!"
    Write-Error "Expected: elimux-backend"
    Write-Error "Run: railway link"
    exit 1
}

# Check live API
try {
    $response = Invoke-WebRequest -Uri "https://api.elimux.ke/health" -Method GET -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        Write-Host "Live API responding" -ForegroundColor Green
    } else {
        Write-Warning "Live API returned status $($response.StatusCode) — proceed with caution"
    }
} catch {
    Write-Warning "Live API not responding — proceed with caution"
}

Write-Host "Pre-deploy check passed" -ForegroundColor Green
Write-Host "You can safely deploy now."
