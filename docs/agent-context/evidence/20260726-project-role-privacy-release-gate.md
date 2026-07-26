# Unit 7 Privacy And Release-Gate Evidence

Date: 2026-07-26
Scope: DD9 only

## Protected input

The release gate covers the complete fixed denylist:

- 4 application identifiers
- 2 machine-root paths
- 4 personal Bot names

The protected values are not stored in the current tracked tree. For local and CI
verification, `tools/extract-privacy-denylist.mjs` derives the complete input at
runtime from the two known historical commits into a mode-0600 temporary file.
The scanner fails closed when the input is absent, unreadable, incomplete,
duplicated, or contains unexpected categories. Test fixtures use only fictional
values.

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

## Remote-history reachability

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

Current tracked content is clean under the complete denylist. Remote-history
remediation is not complete: rewriting or deleting any shared branch, pull ref,
tag, or release remains a separate destructive G11 action requiring explicit
Decision Owner authorization. Unit 7 performs no history rewrite, force push,
tag deletion, release mutation, or G11 action.
