# Manual browser test checklist

Run `./test.ps1` on Windows or `./test.sh` on macOS/Linux first. Then load each
extension unpacked in Chrome, Chromium, or Helium.

## Loading in Helium

Helium supports Chromium extensions. Open `helium://extensions` (use
`chrome://extensions` if that alias is unavailable), enable **Developer mode**,
and choose **Load unpacked**. Select one extension directory at a time:

- `strwBalt/extension`
- `strwBooster`
- `strwBPM`
- `strwTranslate`

After editing an extension, return to the extensions page and press its reload
button. Keep this repository in place: an unpacked installation points at the
folder rather than copying it elsewhere.

For each extension, open **Details** and then **Inspect views / Service worker**
to watch its console during testing. Helium is currently beta, so record whether
any failure also reproduces in ordinary Chromium before treating it as an
extension regression.

## strwBalt

- Run `strwBalt/install-windows.bat` or `strwBalt/install.sh`. Confirm all three
  status indicators are healthy without creating an `.env` file or entering an
  API key.
- Download one short YouTube video and one Spotify track. Confirm progress is
  reported and the resulting file opens.
- Start a Spotify download and a YouTube download together. Confirm each job
  continues polling its correct backend and history labels them `spotdl` and
  `yt-dlp` respectively.
- Temporarily stop `ytdlp-api`, request a YouTube download, and confirm the
  fallback/failure is reported without changing the backend used by another
  concurrent Spotify job.
- In Options, enter a non-local test backend. Confirm Chrome asks for host
  permission. Deny it and confirm the setting is not saved; grant it and confirm
  it can be saved.
- From a normal website's DevTools console, attempt a cross-origin request to
  `http://127.0.0.1:9100/health`. Confirm the response is not readable by the
  page because the API no longer sends wildcard CORS headers.

## strwTranslate

- On first translation, confirm the disclosure explains which page data is sent
  to Google. Cancel and verify nothing changes; retry and accept.
- Translate a page, then restore it. Confirm unchanged translated text, title,
  alt text, placeholders, and labels return to their originals.
- Translate a dynamic page, change a translated element through DevTools, then
  restore. Confirm your newer value is preserved rather than overwritten with
  the stale original.
- Open a second site after accepting the disclosure. Confirm the disclosure is
  not repeatedly shown.

## Regression smoke tests

- strwBooster: boost media, toggle the limiter, reload, and confirm the saved
  per-site level is restored.
- strwBPM: resolve a Spotify track, optionally analyse its preview, and confirm
  history/log rendering works.
- Check the extensions page and each extension service-worker console for
  uncaught exceptions after completing the tests.
