---
name: email-campaigns
description: "Use when planning or writing marketing emails: newsletters, launches, onboarding or re-engagement sequences, subject lines."
category: Business
---

# Email campaigns

## Plan

- **Goal and metric**: opens are unreliable (privacy features); judge by clicks, replies, conversions.
- **Audience segment**: who receives it and why it's relevant to them (new sign-ups, customers
  who haven't ordered in 90 days, trial users on day 3…).
- **Offer and CTA**: one primary action per email.
- **Timing**: send time in the audience's time zone; frequency that doesn't fatigue.

## Anatomy of one email

1. **Subject** (≤ 45 characters ideal, keyword first) + **preheader** (≤ 90 characters, extends the subject).
2. **Opening line**: the value, immediately.
3. **Body**: short paragraphs or 3 bullets; one image idea max; personalization only if data exists
   (`{{first_name|there}}` with a fallback).
4. **CTA button** text = the action ("Book my class"), repeated once for long emails.
5. **Footer**: sender identity, physical address, why they get this, unsubscribe link (required by
   CAN-SPAM/GDPR/CASL), preference link.

Give 3–5 subject line variants with different angles (benefit, curiosity, urgency, personal,
question) for A/B testing. Avoid spammy patterns: ALL CAPS, "!!!", "FREE $$$", misleading "Re:".

## Sequences

| Sequence | Typical emails |
|---|---|
| Welcome / onboarding | Day 0 welcome + first step · Day 2 key feature/how-to · Day 5 social proof · Day 9 offer or check-in |
| Abandoned cart | 1 h reminder · 24 h objections/FAQ · 72 h small incentive (optional) |
| Re-engagement | "We miss you" + value · best content/offer · last chance to stay subscribed |
| Launch | Teaser · launch day · social proof/FAQ · last call |

Write a sequence as a table (email #, delay, trigger/condition, subject, goal) and then each email
in full, one file per email if asked (`emails/01-welcome.md`).

## HTML emails

Keep layout simple (single column, 600 px wide, inline CSS, table-based layout for old clients),
alt text on images, live text instead of text-in-images, and a plain-text version. Many teams paste
copy into their email tool (Mailchimp, Brevo, HubSpot); deliver copy in that shape unless HTML is asked.

## Compliance and consent

Only email people who opted in (or have an existing customer relationship, depending on the law);
honor unsubscribes promptly; don't buy lists. Mention when a request seems to conflict with this.

## Checklist

- [ ] Subject + preheader work together; variants provided.
- [ ] One clear CTA; links and merge tags (with fallbacks) correct.
- [ ] Dates, prices, codes and expiry correct.
- [ ] Unsubscribe and sender details present.
- [ ] Reads well on mobile (short lines, big button).

## Done when

The campaign or sequence has a goal, segment, timing and complete emails with subject variants,
ready to load into the email tool.
