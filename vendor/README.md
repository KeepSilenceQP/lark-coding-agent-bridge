# Vendored packages

## `@larksuite/channel@0.6.0-qp.1`

- Source: npm `@larksuite/channel@0.6.0` distribution tarball
- Upstream tarball SHA-256: `6ece4701ab11025d6af06c00cdb12c41cb0026bc140ce7d260496a661f1b3e00`
- Maintained patch: preserve full-snapshot rollover progress so later
  `setContent()` calls do not replay chunks already finalized into earlier cards
- Vendored tarball SHA-256: `449ee16106a1afd2557f817e867988c09a7b44be609a24967ff061482ab51bff`

The tarball is committed so local installs, CI, and deployments do not require
registry access. Rebuild it from the stated public tarball and reapply the
documented patch before changing the dependency version.
