# Runtime Verification

Date: 2026-06-17

Run from the project root:

```sh
npm run install:native-bridge
npm run build
VERIFY_APP_SERVER=1 npm run verify:runtime
```

The verifier launches Chrome for Testing with a temporary copy of `dist/`, injects the extension public key so Chrome assigns the stable local extension ID, seeds the native-host manifest into the temporary profile, and checks the browser-control path end to end.

To verify Google Chrome Stable:

```sh
CHROME_BINARY="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" VERIFY_APP_SERVER=1 npm run verify:runtime
```

Chrome Stable no longer honors command-line unpacked extension loading in branded builds, so the verifier uses CDP pipe mode and `Extensions.loadUnpacked` for that path. Chrome for Testing still uses the command-line extension load path.

Currently verified:

- Stable Chrome can load the unpacked extension through CDP and preserve the fixed extension ID.
- Popup renders `Codex (OS Extension)` and connected native-host status.
- `GET_NATIVE_HOST_STATUS` returns a structured connected response.
- `ensure_codex_app_server` returns the expected bridge response with `VERIFY_APP_SERVER=1`.
- Content overlay injects and answers `CONTENT_PING`.
- Favicon badges apply and restore without rewriting the page favicon.
- `chrome.debugger.attach`, `Runtime.evaluate`, and `chrome.debugger.detach` work from the extension context.
- Codex browser-client discovery can connect to the installed extension through the native bridge.
