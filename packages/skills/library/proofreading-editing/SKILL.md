---
name: proofreading-editing
description: "Use when proofreading or editing text: grammar, spelling, clarity, tone, length, style-guide consistency, with changes shown."
category: Documents & writing
---

# Proofreading and editing

Respect the author's voice and meaning. Change what improves the text; explain what matters.

## Ask yourself which level is wanted

| Level | What you change |
|---|---|
| Proofread | Spelling, grammar, punctuation, typos, consistency (names, numbers, capitalization). Nothing else. |
| Copy edit | + clarity, word choice, sentence structure, repetition, style guide compliance |
| Line / substantive edit | + structure, flow, cutting and reordering, tone, argument strength |

If the person didn't say, do a copy edit and suggest bigger changes separately.

## Passes (one concern at a time)

1. **Meaning**: anything ambiguous, contradictory or unsupported? Flag rather than guess.
2. **Structure** (substantive edits): logical order, each paragraph one idea, strong opening.
3. **Sentences**: split long ones; active voice where the actor matters; remove redundancy
   ("in order to" → "to", "very unique" → "unique", "past history" → "history").
4. **Words**: precise and plain; consistent terms for the same thing; no jargon for general readers.
5. **Mechanics**: spelling (US vs UK consistent with the text or style guide), grammar, punctuation,
   capitalization, number style (one to nine in words, 10+ as digits, or per style guide),
   dates, units, hyphenation.
6. **Consistency**: names, product names, titles, bullet punctuation, heading case.
7. **Facts to double-check** (flag, don't change): figures that don't add up, dates, quotes.

## Showing changes

Choose what helps the person:
- **Clean version** + a short list of significant changes and why.
- **Change table**:
  | Original | Edited | Reason |
  |---|---|---|
  | "We utilize a variety of tools" | "We use several tools" | Plainer, shorter |
- **Diff** for files: save `text.edited.md` and show `diff -u text.md text.edited.md | head -80`.
- For Word documents, describe tracked-change equivalents or produce an edited copy
  (see `word-documents`); never overwrite the original.

## Style guide

Follow the organization's style guide or brand voice skill when one exists; otherwise be consistent
with the document itself. Note any choices you made (e.g. "used Oxford comma throughout").

## Don't

- Rewrite into your own voice or change meaning, facts, legal wording or quotes.
- "Fix" deliberate style (dialogue, slogans, brand capitalization) without asking.
- Over-edit a proofread request.

## Done when

The text is error-free at the requested level, meaning is unchanged, changes are summarized, and
questions about facts or intent are listed.
