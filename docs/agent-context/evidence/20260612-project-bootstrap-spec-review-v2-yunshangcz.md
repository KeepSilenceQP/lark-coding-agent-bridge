# 云上C总 Spec Review V2

task_id: project-bootstrap-phase2-spec-review-v2-yunshangcz
phase: spec_review
source_message_id: om_x100b6d88fed110a4c246d9c84734d26
delivery_correction_message_id: om_x100b6d88fc9070b8c03a75569d1e94b
result: GO-with-musts

## Conclusion

D1-D5 are acceptable and implementation may start after M1 is written into the spec and M2 is
confirmed.

## M1 Required Identity Matching Rule

Display-name-only matching is not acceptable because bot display names are mutable,
non-unique, and normalization-sensitive.

Required rules:

1. Registry adds `canonical_name` and `aliases[]`.
2. Matching uses NFC-normalized exact equality only.
3. No substring or fuzzy matching.
4. Pin-on-first-verify: after the first successful match and structured verified receipt,
   persist the live `open_id` as a pinned binding. This is a cache, not global source of truth.
5. Rebind protection: if a name match resolves to a different `open_id` than the pinned
   binding, do not auto-rebind. Mark `blocked(identity_changed)` and require human-admin
   confirmation.
6. Ambiguity hard-fails: zero matches or multiple matches -> `blocked(ambiguous_name)`.
7. If `chat.members bots` exposes an app id such as `cli_...`, prefer app id as the anchor;
   otherwise use the pinning rule.

## Delivery Correction Case

云上C总 reported that its previous message likely mentioned 小P with 小P's Context Pack
`open_id`, which is not valid from 云上C总's app perspective. It re-sent using 云上C总's own
live view of 小P.

This confirms the design rule: delivery mentions must use the sending app/profile's live
identity resolution. Registry `open_id` values are metadata/cache only, not cross-app delivery
truth.

## M2 Verified Semantics

Verified must be based on a structured receipt from the target bot:

- target bot structurally mentions 小P;
- receipt includes matching `task_id`;
- receipt includes fixed `status` / execution-result fields.

小P must not infer verified by reading free-form chat history.

## Additional Tests

13. Same display name for two bots -> `blocked(ambiguous_name)`.
14. Rename/rebind conflict -> `blocked(identity_changed)`.
15. Pinned binding hit bypasses name matching.
16. Name matching uses NFC normalization and exact equality only.
