---
name: email-workflows
description: >
  This skill should be used when the user asks to work with their email via the
  gmail-imap tools — e.g. "check my email", "search my inbox", "find emails from X",
  "download the attachments", "reply to that email", "send an email", "archive
  these messages", "summarize my unread mail", or when troubleshooting gmail-imap
  setup ("gmail-imap is not configured").
metadata:
  version: "1.0.0"
---

# Email workflows with gmail-imap

The gmail-imap MCP server exposes nine `gmail_*` tools backed by plain IMAP/SMTP
with App Password auth. They work with Gmail by default and any IMAP/SMTP
provider via config overrides.

## Searching effectively

`gmail_messages_search` runs server-side IMAP search. Key behaviors:

- `query` free text is AND across whitespace-separated terms; literal `OR`
  creates alternation: `invoice OR fattura OR receipt`.
- Gmail-style inline operators are auto-extracted from `query`: `from:`, `to:`,
  `subject:"multi word"`, `has:attachment`, `is:unread`, `is:starred`,
  `in:LABEL`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`. Prefer them — they
  filter on the server.
- Explicit parameters (`from`, `unread`, `since`, `hasAttachment`, …) win over
  inline operators when both are given.
- With no date filter the search defaults to the **last 30 days**. To search
  further back, pass `since` explicitly.
- For exact Gmail web-UI semantics on Gmail accounts, pass `gmailRaw` with full
  Gmail search syntax — it bypasses all local parsing.
- Paginate by passing `before` set to the `date` of the oldest message seen.

Mailbox names are localized IMAP paths (e.g. `[Gmail]/Posta inviata`, not
`[Gmail]/Sent Mail`). When a search over sent mail or a label returns nothing,
run `gmail_mailboxes_list` first and use the exact path.

## Reading messages and threads

- `gmail_message_get` fetches one message by `uid` (+ optional `mailbox`).
  HTML-only messages are converted to readable plain text automatically.
- `gmail_thread_get` fetches the whole Gmail conversation containing a UID,
  chronologically. Use it before replying so the reply reflects the full
  context. Gmail-only (requires X-GM-EXT-1).

## Attachment workflow

`gmail_message_attachments_save` writes attachments to disk and returns
**absolute paths**. Chain those paths directly into Read, PDF/XLSX/DOCX skills,
or scripts. Typical flow:

1. `gmail_messages_search` with `has:attachment` to find the message.
2. `gmail_message_attachments_save` with its `uid` (optionally `filenames` to
   pick specific files).
3. Read/process the returned paths.

Files land under `<attachmentsDir>/<mailbox>-<uid>/` and re-downloads of the
same UID reuse that directory.

## Sending and replying — confirmation guardrail

`gmail_message_send` and `gmail_message_reply` refuse to run unless the call
includes `confirm: true` (default config). This is intentional protection
against prompt injection and accidental sends. Workflow:

1. Draft the email and show it to the user (recipients, subject, body).
2. Only after the user approves, repeat the call with `confirm: true`.

Never pass `confirm: true` on the first attempt or without explicit user
approval of the exact content. `gmail_message_reply` handles `Re:` subjects,
`In-Reply-To`/`References` threading, and quoting automatically; `replyAll: true`
CCs all original recipients excluding the user's own addresses.

## Organizing

- `gmail_message_update` sets read/unread and starred state.
- `gmail_message_move` moves between mailboxes (archive = move to
  `[Gmail]/All Mail` equivalent, or the user's archive folder).

## Setup troubleshooting

If tools fail with "gmail-imap is not configured", help the user create
`~/.gmail-imap/config.json`:

```json
{
  "username": "you@gmail.com",
  "appPassword": "xxxxxxxxxxxxxxxx",
  "fromName": "Your Name"
}
```

The App Password comes from <https://myaccount.google.com/apppasswords>
(requires 2-Step Verification; spaces in the shown password are stripped
automatically). Environment variables (`GMAIL_USERNAME`, `GMAIL_APP_PASSWORD`,
…) override the file. For non-Gmail providers add `imap`/`smtp` host overrides —
see the plugin README for tested host pairs (Fastmail, iCloud, Outlook, Aruba).

Auth errors ("Invalid credentials", "Web login required") usually mean 2FA is
off, the app password is stale, or IMAP is disabled in Gmail settings
(Forwarding and POP/IMAP → enable IMAP).
