# Vendored packages

## `@larksuite/channel@0.6.0-qp.2` (active)

- Baseline: the exact maintained `.1` tarball below, including its rollover fix.
- Maintained patch: automatic keepalive only replaces the WebSocket. Its probe
  rechecks shutdown and connection recovery after awaiting HTTP, and watchdog
  ticks run one at a time. Disconnect marks the channel closed before asynchronous
  disposal; late handshake failures cannot invoke the recovery callback after stop.
- Reviewable TypeScript diff, extracted from the baseline's source map:
  [`patches/larksuite-channel-0.6.0-qp.2.patch`](patches/larksuite-channel-0.6.0-qp.2.patch).
- Vendored tarball SHA-256: `8010256ffe6656f2dcf86be97ae8099639601e50cafb782377545aa938090b7a`.

Reproduce from the repository root with `node tools/repack-larksuite-channel.mjs`.
The script validates the baseline SHA-256 and every replacement, patches both
ESM and CJS bundles, and uses `npm pack --ignore-scripts` without rebuilding
unrelated code. Package exports, declarations, dependencies, and the rollover fix
are unchanged. Source maps and their URLs are removed because their original
positions would be inaccurate after the patch; the source review diff is retained
here instead of shipping misleading debug locations. The baseline `.1` archive
is intentionally retained as the offline, reproducible patch input; only `.2` is
installed as a dependency.

Verification uses the real installed SDK's keepalive and reconnect lifecycle in
`tests/integration/bot/keepalive-run-continuity.test.ts`. Socket handshakes and
Feishu API calls are isolated in the test. The current node-sdk dependency also
guards an in-flight handshake after `WSClient.close()` with its closed flag and
connection generation; the channel patch retains that transport implementation.

## `@larksuite/channel@0.6.0-qp.1`

- Source: npm `@larksuite/channel@0.6.0` distribution tarball
- Upstream tarball SHA-256: `6ece4701ab11025d6af06c00cdb12c41cb0026bc140ce7d260496a661f1b3e00`
- Maintained patch: preserve full-snapshot rollover progress so later
  `setContent()` calls do not replay chunks already finalized into earlier cards
- Vendored tarball SHA-256: `449ee16106a1afd2557f817e867988c09a7b44be609a24967ff061482ab51bff`

The tarball is committed so local installs, CI, and deployments do not require
registry access. Rebuild it from the stated public tarball and reapply the
documented patch before changing the dependency version.
