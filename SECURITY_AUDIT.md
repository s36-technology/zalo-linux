# Security Audit

Date: 2026-06-02

## Scope

Reviewed the maintainable Linux-port code paths:

- Package scripts and Electron Builder configuration.
- Electron bootstrap and native module loader wrappers.
- Static scan of selected bundled Electron files for high-risk patterns.

The app payload in `main-dist/` and `pc-dist/` is mostly minified upstream bundle output. Refactoring those files without original source maps is high risk and was limited to static review.

## Fixed

- Removed legacy shell entrypoints that duplicated package-managed flows: `install.sh`, `start.sh`, `update.sh`, `build-appimage.sh`, and `toggle-devtools.sh`.
- Consolidated development and packaging under `package.json` scripts and Electron Builder.
- Added reproducible Yarn metadata with `packageManager`.
- Added Linux fallback for `native/nativelibs/zwalker/index.js` so missing native bindings use the existing stub instead of crashing.

## Findings Remaining

- Electron is pinned to `v22.3.27`, which is old. The README says newer Electron versions currently break the app, so this remains a compatibility/security tradeoff.
- `native/nativelibs/zcall/vcmac.js` contains HTTP endpoints:
  - `http://api.conf.talk.zing.vn/genuid`
  - `http://api.conf.talk.zing.vn/zls?action=call_config`
- Bundled code contains `eval` and `new Function` patterns, mostly from vendor/minified dependencies and worker pools.
- Bundled code contains a Google Maps API key string. Treat it as public client config unless the upstream owner confirms it is restricted by domain/app.
- Some bundled BrowserWindow options appear to relax `webSecurity` in development paths. Production paths mostly show `nodeIntegration: false`, `contextIsolation: true`, and `webSecurity: true`.
- Several React-era dependencies still declare legacy peer ranges and should be replaced or downgraded together with React after runtime testing.

## Verification

Commands run:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
YARN_IGNORE_ENGINES=1 yarn run pack --publish never
node --check bootstrap.js
node --check native/nativelibs/index.js
node --check native/nativelibs/zwalker/index.js
```
