# Unit 7 Privacy And Release-Gate Evidence

Date: 2026-07-26
Scope: DD9 only

## Protected input

The release gate covers the complete fixed denylist:

- 4 application identifiers
- 2 machine-root paths
- 4 personal Bot names

The protected values are not stored in the current tracked tree. For local and CI
verification, the complete input is supplied from a mode-0600 local file or the
`LARK_BRIDGE_PRIVACY_DENYLIST_JSON` GitHub Actions secret. CI materializes that
secret only into its runner's temporary directory with a restrictive umask. The
scanner and real pack-and-verify runner fail closed when the protected input is
absent, unreadable, incomplete, duplicated, or contains unexpected categories.
They do not recover the values from repository history. Test fixtures use only
fictional values.

## Current-content cleanup

The initial tracked-tree scan reported 102 category/file findings:

| Category | Initial | Final |
| --- | ---: | ---: |
| Application identifiers | 0 | 0 |
| Machine-root paths | 17 | 0 |
| Personal Bot names | 85 | 0 |
| **Total** | **102** | **0** |

The cleanup replaced protected current content in 45 tracked files, including
old plans, specifications, agent-context evidence, task packets, operator
prompts, tests, and fixtures. There are no path, file-type, documentation, or
historical-evidence exemptions. A semantic regression caused by a whitespace
bearing fictional mention was corrected with a no-whitespace fictional mention;
the affected intake tests and privacy-tool tests pass.

Final release-gate results:

| Surface | Input | Result |
| --- | --- | --- |
| Tracked tree | `git ls-files -z` working-tree contents | 0 findings |
| Built `dist/` | Recursive current build output | 0 findings |
| Actual package | Entries of the exact `.tgz` produced by `npm pack` | 0 findings |
| Clean install | The same scanned `.tgz` | Passed |

`prepack` scans only the tracked tree and current `dist/`, then preserves the
existing bundle-closure check. It does not claim to scan a tarball that has not
yet been generated. `tools/pack-and-verify.mjs` owns the post-pack lifecycle:
temporary release source, actual `npm pack`, entry-by-entry tarball scan, and
clean installation of that same tarball. CI package smoke and npm publish use
this runner; publishing targets the verified artifact rather than repacking the
source.

## Initial reachability and scoped remediation

Read-only evidence was collected with a full fetch, `git ls-remote origin`, and
ancestry checks against every fetched branch and tag. Both known historical
commits (`665ad74` and `a0464f7`) remain reachable from the same remote refs:

- remote `HEAD`
- `refs/heads/feat/azu-group-prompt-guided-bugfix`
- `refs/heads/feat/project-role-assignment`
- `refs/heads/fix/bugfix`
- `refs/heads/fix/bugfix2`
- `refs/heads/main`
- `refs/pull/1/head`
- `refs/pull/2/head`
- `refs/pull/3/head`
- `refs/pull/4/head`
- `refs/pull/5/head`
- `refs/pull/6/head`
- `refs/pull/7/head`
- `refs/pull/8/head`
- `refs/pull/9/head`
- `refs/pull/11/head`
- `refs/tags/v0.5.9-qp.1`
- `refs/tags/v0.5.9-qp.4`

Unit 7 performed no history mutation. After Unit 10 closed, the Decision Owner
separately authorized G11 and then narrowed its target to source commit history.
The operation:

- created a private mirror backup containing 5 heads, 2 tags, and 11 pull refs;
- moved the release gate from historical extraction to a mode-0600 local file
  or the `LARK_BRIDGE_PRIVACY_DENYLIST_JSON` GitHub Actions secret;
- rewrote only the 5 remote `refs/heads/*` with
  `git-filter-repo --sensitive-data-removal --no-fetch`;
- updated those 5 heads in one atomic push with an exact lease for every old
  tip; and
- fetched the heads again from GitHub and scanned their complete fast-export:
  all 10 protected patterns had 0 findings and `git fsck` was clean.

The first replacement attempt was rejected locally before any push because
space-bearing fictional Bot names changed command tokenization. The accepted
rewrite uses no-whitespace fictional Bot names; the rewritten `main` passed
133 test files (1331 passed, 33 skipped), typecheck, and build.

Old pull refs, tags, releases, caches, and GitHub Support remediation were
explicitly left outside the narrowed authorization. This evidence therefore
proves current-content cleanup plus source-branch-history cleanup, not complete
removal from every GitHub-side ref or retained object.
