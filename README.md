# Arcodex Extension

Local Chrome/Arc extension for connecting Codex to the browser.

## What It Fixes

The official Codex Chrome extension connects in Arc and can run JavaScript on existing tabs, but its `createTab` flow hangs in Arc after opening blank tabs. Recent Codex browser-client builds also call session APIs such as `browser.user.openTabs()` without a `browser_id`, which older reconstructed builds rejected.

Arcodex keeps the same extension ID and native bridge contract while fixing Arc tab creation, restoring normal foreground/background tab control, accepting current Codex session payloads, and avoiding favicon flicker during tab status updates.

## Install

Use the prebuilt release:

```text
releases/1.1.14/codex-os-extension-1.1.14.zip
```

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Drag `codex-os-extension-1.1.14.zip` onto the extensions page.
4. Confirm the install prompt.

If Chrome refuses the ZIP, unzip it and use `Load unpacked` on the extracted folder.

For Codex connectivity from this checkout, install the native bridge:

```sh
npm run install:native-bridge
```

## Develop

```sh
npm install
npm run check
npm run check:runtime

CHROME_BINARY="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" VERIFY_APP_SERVER=1 npm run verify:runtime
```

Build a fresh release:

```sh
npm run package:release
```

Load the unpacked build from:

```text
/Users/bennett/Documents/Projects/arcodex/dist
```

## Layout

```text
src/        Extension source
scripts/    Build, release, native bridge, verification
tests/      Unit and behavior tests
docs/       Operational notes
releases/   Prebuilt release artifacts
dist/       Generated unpacked extension
```
