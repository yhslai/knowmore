---
name: discuss-ticket
description: Read a ticket from the repo's knowledge base and think about how we should implement it. Triggered by `discuss-ticket <ticket-name>` or `plan-ticket <ticket-name>`.
---

# Discuss Ticket

## Read Ticket

Read the ticket from the repo's knowledge base. Usually located in `./{PROJECT_KNOWLEDGE_BASE}/tickets/`. Note that the ticket is usually at top level. If the ticket is nested in `tickets/done` or `tickets/pending` folders, it's likely not the one you want.

The ticket might refer to other tickets, images, documents and resources. Remember to read them too.

## Research

Think about the implementation or architecture detail of the tickets. If your don't have sufficient information or context, use `kb_*` and `km_*` tools to gather more details.

Be aware of the best practices and common pitfalls, while keeping an flexible and open mind to new ideas and approaches.

## Discuss / Plan

If the prompt is `discuss-ticket`, tell me your thoughts and if you have several equally good options, suggest them all. If the prompt is `plan-ticket`, write your plan in the ticket file under a h1 heading `# Implementation Plan` and brief me about it.

## Do Not Commit

Don't make code change or commit anything.