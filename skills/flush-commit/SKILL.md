---
name: flush-commit
description: Read all the uncommitted and untracked files and see if it's sensible to make commit
---

# Flush Commit

## Get Files
Via git, read all the current uncommitted change and untracked files.

## Sanity Check
Read these files and check:
- They're just scaffolding or housekeeping stuff, not implementing features or important changes
- They're not big binary files that are not tracked by git-lfs
- They're not files that are conventionally ignored by git

If any of these checks failed, abort and tell me what's wrong.

## Commit
If the sanity check passes, use git to add and commit the changes.



