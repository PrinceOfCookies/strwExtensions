$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "[1/5] JavaScript syntax"
$jsFiles = & rg --files -g '*.js'
foreach ($file in $jsFiles) { & node --check $file }
if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed" }

Write-Host "[2/5] JSON manifests"
$jsonFiles = & rg --files -g '*.json'
foreach ($file in $jsonFiles) { Get-Content -Raw $file | ConvertFrom-Json | Out-Null }

Write-Host "[3/5] Compose configuration and localhost bindings"
Push-Location "$root\strwBalt"
try {
    & docker compose config --quiet
    if ($LASTEXITCODE -ne 0) { throw "Compose configuration is invalid" }
    $config = & docker compose config
    if (($config | Select-String -Pattern "host_ip: 127.0.0.1").Count -lt 3) {
        throw "All three published ports must bind to 127.0.0.1"
    }

    Write-Host "[4/5] yt-dlp API unit tests"
    & docker compose build ytdlp-api
    if ($LASTEXITCODE -ne 0) { throw "yt-dlp image build failed" }
    & docker compose run --rm --no-deps --entrypoint python ytdlp-api -m unittest -v test_server.py
    if ($LASTEXITCODE -ne 0) { throw "yt-dlp API tests failed" }

    Write-Host "[5/5] SpotDL API unit tests"
    & docker compose build spotdl-api
    if ($LASTEXITCODE -ne 0) { throw "SpotDL image build failed" }
    & docker compose run --rm --no-deps --entrypoint python spotdl-api -m unittest -v test_server.py
    if ($LASTEXITCODE -ne 0) { throw "SpotDL API tests failed" }
} finally {
    Pop-Location
}

Write-Host "All automated checks passed."
Write-Host "Complete MANUAL_TESTS.md for browser-only behavior."
