---
name: knowmore-web
description: Web retrieval with Brave Search. Use this when the user asks for recent facts, external documentation, or information not guaranteed to be in local files.
---

# Knowmore Web Retrieval

## When to use

Use this skill when:
- The question depends on external knowledge or recent updates
- The user asks for documentation links, references, or citations
- You are uncertain and need verification before answering

## Workflow

1. Choose the first tool based on task shape:
   - Use `km_research_web` first for broad/uncertain questions, synthesis requests, or when you need quick multi-source context.
   - Use `km_search_web` first for fast link discovery, known-doc lookup, troubleshooting source selection, or when you want tight control over which URLs are fetched.
2. If you started with `km_search_web`, then use `km_fetch_url` on the best 1-3 URLs as needed.
3. If you started with `km_research_web`, use `km_fetch_url` on top source URL(s) ONLY IF the distilled output is insufficient.
4. Answer in the best format for the user request (not always bullet points).
5. Keep source links available; share them when helpful or requested.
6. If results are weak, refine query and try again (switch tools if helpful).

## Notes

- Do not over-research: stop and return once you believe you've got enough information for the task.  
  No matter if you got the info from distilled context or fetched URLs.
- Do not dump full pages into the final answer.
- Prefer extracted snippets and short sourced summaries.
- Mention uncertainty if no strong sources are found.