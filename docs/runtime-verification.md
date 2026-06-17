# Runtime Verification

Date: 2026-06-17

Run from the project root:

```sh
npm run install:native-bridge
npm run build
VERIFY_APP_SERVER=1 npm run verify:runtime
```

The verifier launches Chrome for Testing with a temporary copy of `dist/`, injects the extension public key so Chrome assigns the stable local extension ID, seeds the native-host manifest into the temporary profile, and checks the browser-control path end to end.

Currently verified:

- Popup renders `Codex (OS Extension)` and connected native-host status.
- `GET_NATIVE_HOST_STATUS` returns a structured connected response.
- `ensure_codex_app_server` returns the expected bridge response with `VERIFY_APP_SERVER=1`.
- Content overlay injects and answers `CONTENT_PING`.
- Favicon badges apply and restore without rewriting the page favicon.
- `chrome.debugger.attach`, `Runtime.evaluate`, and `chrome.debugger.detach` work from the extension context.
- Codex browser-client discovery can connect to the installed extension through the native bridge.
