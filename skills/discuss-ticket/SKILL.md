---
name: discuss-ticket
description: Read a ticket from the repo's knowledge base and think about how we should implement it. Triggered by `discuss-ticket <ticket-name>`, `plan-ticket <ticket-name>`, or `replan-ticket <ticket-name> <step-number>`.
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

Implementation Plan should provide a step-by-step approach. Each step should be a `## S{step_number}: {title}` h2 heading. You're allowed to write additional notes or explanations with h3 or h4 heading under each step, or with h2 headings before/after all steps.

Each step should leave the project in a valid, consistent state. Even for an intermediate state, ensure that the project remains functional and does not introduce bugs or build failures.

If the prompt is `replan-ticket <ticket-name> <step-number>`, re-plan the implementation plan from the specified step. Remember whe replanning you need to do research and gather information again, not just rewriting the existing plan in different words or reordering steps mindlessly. You can safely ignore the steps BEFORE the specified step. You are allowed create/modify/reorder/merge/remove the steps after the specified step.

## Do Not Commit

Don't make code change or commit anything.