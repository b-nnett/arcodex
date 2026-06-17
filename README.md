# Arcodex Extension

Local Chrome/Arc extension for connecting Codex to the browser.

## What It Fixes

The official Codex Chrome extension connects in Arc and can run JavaScript on existing tabs, but its `createTab` flow hangs in Arc after opening blank tabs. Recent Codex browser-client builds also call session APIs such as `browser.user.openTabs()` without a `browser_id`, which older reconstructed builds rejected.

Arcodex keeps the same extension ID and native bridge contract while fixing Arc tab creation, restoring normal foreground/background tab control, accepting current Codex session payloads, and avoiding favicon flicker during tab status updates.

## Install

Download the prebuilt release from [Arcodex Extension 1.1.14](https://github.com/b-nnett/arcodex/releases/tag/v1.1.14):

- [codex-os-extension-1.1.14.zip](https://github.com/b-nnett/arcodex/releases/download/v1.1.14/codex-os-extension-1.1.14.zip)
- [SHA-256 checksum](https://github.com/b-nnett/arcodex/releases/download/v1.1.14/codex-os-extension-1.1.14.zip.sha256)

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Drag `codex-os-extension-1.1.14.zip` onto the extensions page.
4. Confirm the install prompt.

If Chrome refuses the ZIP, unzip it and use `Load unpacked` on the extracted folder.

## Connect To Codex

The extension also needs a local Native Messaging bridge. Chrome and Arc use that bridge to let Codex talk to the extension; the extension ZIP cannot register it by itself.

From a cloned copy of this repo, run:

```sh
npm install
npm run install:native-bridge
```

The installer registers the bridge for Chrome and Arc, and backs up any existing native-host manifest first.

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

The local release artifact is written to:

```text
releases/1.1.14/codex-os-extension-1.1.14.zip
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
