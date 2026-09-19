# Testing

## Automated checks

Requirements: Docker Desktop (running), Node.js, and `rg` (ripgrep).

On Windows, open PowerShell in the repository root:

```powershell
.\test.ps1
```

On macOS or Linux:

```sh
chmod +x test.sh
./test.sh
```

The runner validates every JavaScript file and JSON manifest, validates the
Compose file and its three loopback-only port bindings, builds both backend
images, and runs their Flask API tests inside the containers. The API tests
cover request-size limits, URL and option validation, active-job limits, health
checks, and normal job creation without downloading real media.

The tests intentionally do not download third-party media, depend on live
Spotify/YouTube responses, or alter an existing Compose deployment.

## Browser checks, including Helium

Continue with [MANUAL_TESTS.md](MANUAL_TESTS.md). Those checks cover browser
permission prompts, concurrent downloads, translation disclosure and restore
behavior, and smoke tests for all four extensions.
