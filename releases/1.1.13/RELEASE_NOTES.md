# Codex OS Extension 1.1.13 Release Notes

Date: 2026-06-17

## Artifact

- Extension zip: `releases/1.1.13/codex-os-extension-1.1.13.zip`
- SHA-256: `98540ecee09750a02284f238008a645f59c9af455518ad7dd4800ab857bb93a5`
- Unpacked extension path: `dist/`
- Extension ID: `hehggadaopoacecdllhhajmbjkdcmajg`

The zip has `manifest.json` at the archive root and includes generated source maps for reviewability.

## Release Highlights

- Popup title is `Codex (OS Extension)` so it is easy to distinguish from the Web Store extension.
- Extension icons use the inverted local icon set.
- Background worker is versioned as `background-1.1.13.js` to avoid stale service-worker cache issues.
- Favicon badging now uses a managed Codex favicon link instead of rewriting the page favicon, preventing badge/cursor flicker.
- Content-script ping and cursor-state sends are bounded so unavailable tabs do not hang session leasing.
- Native-host bridge path remains compatible with `com.openai.codexextension` and Codex browser-client discovery.

## Verification

Passed from the project root:

```sh
npm run typecheck
npm run lint
npm test
npm audit --audit-level=high --omit=optional
npm run package:release
VERIFY_APP_SERVER=1 npm run verify:runtime
```

Runtime verifier checks passed:

- Popup shows connected native-host status.
- `GET_NATIVE_HOST_STATUS` works.
- Side panel/app-server message path responds with the expected side-panel-closed state.
- Connected native host services `ensureCodexAppServer`.
- Content overlay injects and responds.
- Favicon badge applies and restores without rewriting the page favicon.
- CDP attach, execute, and detach work from the extension context.

## Install Notes

For local Arc or Chrome testing, load unpacked from:

```text
/Users/bennett/Documents/Projects/arcodex/dist
```

For Codex connectivity, refresh the native bridge if needed:

```sh
npm run install:native-bridge
```
