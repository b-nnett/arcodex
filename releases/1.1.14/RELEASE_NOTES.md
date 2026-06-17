# Codex OS Extension 1.1.14 Release Notes

Date: 2026-06-17

## Artifact

- Extension zip: `releases/1.1.14/codex-os-extension-1.1.14.zip`
- SHA-256: `2d98261c1488fd210d10495a15c80f8ea37d83015ca1c1fd84909c0ef940be1f`
- Extension ID: `hehggadaopoacecdllhhajmbjkdcmajg`

The zip has `manifest.json` at the archive root and includes generated source maps for reviewability.

## Release Highlights

- Fixes current Codex browser-client compatibility for `browser.user.openTabs()` and related session calls.
- Accepts session requests with `session_id` and `turn_id` when the client no longer sends `browser_id`.
- Background worker is versioned as `background-1.1.14.js` to avoid stale service-worker cache issues.

## Verification

Passed from the project root:

```sh
npm run check
npm run check:runtime
CHROME_BINARY="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" VERIFY_APP_SERVER=1 npm run verify:runtime
```

Runtime verifier checks passed:

- Chrome for Testing and Google Chrome Stable both load and run the extension.
- Popup shows native-host status and responds to status refreshes.
- `GET_NATIVE_HOST_STATUS` works.
- Side-panel/app-server message paths respond.
- Content overlay injects and responds.
- Favicon badge applies and restores without rewriting the page favicon.
- CDP attach, execute, and detach work from the extension context.

Live Arc verification:

- Arc loaded extension version `1.1.14` from the unpacked build.
- The repo native bridge returned `getUserTabs` with only `session_id` and `turn_id`; no `browser_id` was sent.
- A fresh Codex thread replayed `[@chrome](plugin://chrome@openai-bundled) what tabs do i have open` and listed tabs successfully.

## Install Notes

For release installs, use `codex-os-extension-1.1.14.zip`.

For Codex connectivity, refresh the native bridge if needed:

```sh
npm run install:native-bridge
```
