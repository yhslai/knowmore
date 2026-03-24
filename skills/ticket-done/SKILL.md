---
name: ticket-done
description: Read the uncommitted files and summarize how the current ticket is done (implemented) in a h1 section at the end of the ticket file, and move the file to `{PROJECT_KNOWLEDGE_BASE}/tickets/done`. Triggerd by `ticket done <ticket-name>` or `td <ticket-name>`. `ticket undo <ticket-name>` to undone a ticket (if no name supplied then it's the ticket you just marked done.)
---

# Ticket Done

This skill is not to implement the ticket. It assumes the ticket is done and does some housekeeping works.

## Read Files
Via git, Read the current uncommitted changes and untracked files.

## Sanity Check
Read the current working ticket, and think about if the uncommitted files are really for that ticket, to ensure this skill isn't called by accident. If it doesn't make sense, abort and tell me what's wrong.

## Notetaking
Write a succinct summary of implementation details of the working ticket, appending it to its own markdown file under a h1 heading `# Done Notes`. Move the .md file to `./{PROJECT_KNOWLEDGE_BASE}/tickets/done`.

## Commit
Use git to add and commit the changes.



