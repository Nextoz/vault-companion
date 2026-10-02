# ADR-0047 — Morning Brief email delivery

Status: accepted (Lead, 2026-10-02) under owner backlog item MB1d.

## Context
The brief JSON (ADR-0046) must also arrive as an email at 06:3x. The owner prefers free tiers; Cloudflare's new Email
Sending (`env.EMAIL.send({from,to,subject,html,text})`) is on the paid Workers plan only.

## Decision
- Use the classic Email Routing `send_email` binding (`BRIEF_EMAIL`, no addresses in `wrangler.jsonc`): free, and it
  can only reach a destination verified on `karpov.dk` Email Routing.
- The Worker builds a base64 UTF-8 `multipart/alternative` MIME message (text + escaped HTML) and sends
  `new EmailMessage(from, to, raw)` (`cloudflare:email`, imported lazily). Subject and bodies are base64, so brief
  text cannot inject headers.
- Addresses are optional Worker secrets `BRIEF_EMAIL_FROM` / `BRIEF_EMAIL_TO`; no mailer unless binding + both exist.
- Send only after a fresh commit (`committed`), best-effort: failure logs `errorCode: 'email-failed'` (no addresses,
  subject or body) and never affects the committed brief.

## Consequences
- No delivery state: a failed send is not retried and a crash between commit and send loses that morning's email
  (the app still has the JSON). Accepted; revisit only if it happens (a retry flag would be a second write target).
- Email carries derived health/mood lines to the owner's own verified mailbox.
- Owner setup: `wrangler secret put BRIEF_EMAIL_FROM` (an address on the Email Routing domain) and `BRIEF_EMAIL_TO`.
