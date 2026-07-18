# Operator-managed Group Prompts

Files in this directory are reviewed deployment inputs for profile-local Group
Prompts. The bridge package does not install them automatically.

To activate a reviewed file, copy its content into the target profile path:

```text
<profileDir>/prompts/groups/<chatId>.md
```

Then issue `/new` in that group. Editing or removing the live file does not
change an already pinned session; `/new` is the activation boundary.

Never copy a Codex-targeted prompt into a Claude profile unless that prompt has
been reviewed and approved for Claude separately.
