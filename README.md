# Arcodex Extension

Local Chrome/Arc extension for connecting Codex to the browser.

## Install

Use the prebuilt release:

```text
releases/1.1.13/codex-os-extension-1.1.13.zip
```

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Drag `codex-os-extension-1.1.13.zip` onto the extensions page.
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
