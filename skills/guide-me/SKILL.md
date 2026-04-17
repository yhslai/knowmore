---
name: guide-me
description: Read a ticket from the repo's knowledge base and guide me to implement it or understand the implementation. Triggered by `guide-me <ticket-name> <step-number>`.
---

# Guide Me on Ticket

## Read Ticket

Read the ticket from the repo's knowledge base. Usually located in `./{PROJECT_KNOWLEDGE_BASE}/tickets/`. Note that the ticket is usually at top level. If the ticket is nested in `tickets/done` or `tickets/pending` folders, it's likely not the one you want.

The ticket might refer to other tickets, images, documents and resources. Remember to read them too.

The ticket should have an h1 heading, `## Implementation Plan`, that outlines the steps for implementing the ticket. Each step is an h2 heading with a title like `## S{step_number}: {title}`. If you don't find such a heading, abort. If I forget to specify a step number, abort (don't assume it's the first step).

## Guide Me

Tell me about the APIs/concepts/practices I need to know to implement this ticket step, but don't write code for me. Read the relevant code, search the knowledge base or the internet to make sure you've got a full picture and is informed enough to guide me.

If you noticed that this step is already implemented in code, then guide me to understand the implementation.