---
name: implement-ticket
description: Read a ticket from the repo's knowledge base and think about how we should implement it. Triggered by `implement-ticket <ticket-name> <step-number>`.
---

# Implement Ticket


## Read Ticket

Read the ticket from the repo's knowledge base. Usually located in `./{PROJECT_KNOWLEDGE_BASE}/tickets/`. Note that the ticket is usually at top level. If the ticket is nested in `tickets/done` or `tickets/pending` folders, it's likely a typo or user mistake, and you should abort.

The ticket might refer to other tickets, images, documents and resources. Remember to read them too.

The ticket should have an h1 heading, `## Implementation Plan`, that outlines the steps for implementing the ticket. Each step is an h2 heading with a title like `## S{step_number}: {title}`. If you don't find such a heading, abort. If I forget to specify a step number, abort (don't assume it's the first step).

If the ticket provides external documents/URLs, make sure fetch(`km_fetch_url` for URLs) and read them first.

## Implement Step

Implement the step specified by `<step-number>`. You can safely ignore the steps AFTER the specified step. You might need to refer to the previous steps or other sections to understand the context.

After implementing the step, the project remains in a valid, consistent state.


## Verify

After implementing the step, you might ensure the automatic tests pass and the project can be built successfully, if the relevant workflows are set up.

And after that, brief me what you did and what I need to manually verify, if any. You don't need to tell me very generic things like "check if the app runs" or "review the code".


## Do Not Commit

Never use git commands or commit anything.