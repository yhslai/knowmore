---
name: flush-push
description: Review all uncommitted and untracked changes, commit them in logically separate groups, then push. Triggered by `flush-push`, or by the exact prompt `just-push`.
---

# Flush Commit

## Get Files

Via git, inspect all staged, unstaged, and untracked changes. Read the diffs and new files.

## Sanity Check

Check that:
- Changes are scaffolding or housekeeping, not features or other important changes.
- No large binary files are being added without git-lfs.
- No conventionally ignored files are being committed.

When the prompt is exactly `just-push`, skip only the first check. This permits feature changes; it does not permit bundling unrelated changes.

If any required check fails, abort and explain why.

## Group Changes

Group changes into logically cohesive commits before staging anything.

- Each commit should have one clear purpose.
- Keep related implementation, tests, and documentation together.
- Separate unrelated features, fixes, and housekeeping.
- Do not treat everything currently modified as one commit.
- Include already-staged changes in this review; staging does not determine commit boundaries.
- If one file contains unrelated changes, stage the relevant hunks separately.

Briefly state the planned commit groups before proceeding.

## Commit

Stage and commit each logical group separately with a descriptive message.

Review each staged diff before committing to confirm it contains only the intended group. Preserve all working-tree changes.

## Push

After all groups are committed, push to the default remote unless specified otherwise.

Confirm push success and report the resulting commits and working-tree status. If pushing fails, report the failure without claiming success.
