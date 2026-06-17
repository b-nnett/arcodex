# Codex Connection

Date: 2026-06-17

The extension connects to Codex through the native messaging host:

```text
com.openai.codexextension
```

The extension ID is kept stable for local Chrome and Arc installs:

```text
hehggadaopoacecdllhhajmbjkdcmajg
```

## Native Bridge

The local bridge lives in:

```text
scripts/codex-native-host-bridge.mjs
scripts/codex-native-host-bridge-wrapper.c
scripts/install-native-host-bridge.mjs
```

Install or refresh it from the project root:

```sh
npm run install:native-bridge
```

The installer writes native messaging manifests for Chrome and Arc, backing up any previous manifest before replacing it. The bridge listens on `/tmp/codex-browser-use/<uuid>.sock` and forwards browser-client JSON-RPC requests to the extension background worker.

## Verification

From the project root:

```sh
npm run typecheck
npm test
npm run build
VERIFY_APP_SERVER=1 npm run verify:runtime
```

Direct bridge probe:

```sh
CODEX_EXTENSION_HOST_PATH="/Users/bennett/Documents/Projects/arcodex/scripts/codex-native-host-bridge-bin" \
  PROBE_METHOD=ensureCodexAppServer \
  PROBE_TIMEOUT_MS=5000 \
  node scripts/native-host-request-probe.mjs
```

Expected direct probe result includes:

```json
{
  "connected": true,
  "bridge": "arcodex-native-host-bridge",
  "localAppServerUrl": null
}
```

## Scope

Keep Arc support inside the normal extension-visible browser surface: tabs, windows, history, tab groups, and CDP-backed tab control. Do not add Arc Spaces support through AppleScript or native app automation in this phase.
