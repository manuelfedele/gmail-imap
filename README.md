# openclaw-gmail-plugin

OpenClaw plugin for Gmail (and any IMAP/SMTP mailbox) using **App Passwords**.

Features:

- List mailboxes / folders / labels
- Search recent messages by sender, recipient, subject, body, flags, date range
- Read full messages with body and attachment metadata
- **Download attachments to disk**
- Mark read/unread, star/unstar
- Move messages between mailboxes
- Send and reply (with optional `replyAll`, in-reply-to threading, attachments)

Defaults are pre-configured for Gmail, but any IMAP/SMTP host works via the optional `imap` / `smtp` overrides.

## Prerequisites

A **Gmail App Password** (16 characters). Requires 2FA on your Google account.
Generate one at <https://myaccount.google.com/apppasswords>.

## Install

```sh
openclaw plugins install github:manuelfedele/openclaw-gmail-plugin
```

Or from a local clone:

```sh
git clone https://github.com/manuelfedele/openclaw-gmail-plugin.git
cd openclaw-gmail-plugin
npm install
npm run build
openclaw plugins install $(pwd)
```

## Configure

Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "gmail": {
        "enabled": true,
        "config": {
          "username": "you@gmail.com",
          "appPassword": "xxxxxxxxxxxxxxxx",
          "fromName": "Your Name"
        }
      }
    }
  }
}
```

That's it for Gmail. For other providers, add `imap` / `smtp` host/port overrides:

```jsonc
{
  "imap": { "host": "imap.fastmail.com", "port": 993, "secure": true },
  "smtp": { "host": "smtp.fastmail.com", "port": 465, "secure": true }
}
```

## Tools

| Tool | Description |
| --- | --- |
| `gmail_mailboxes_list` | List folders/labels |
| `gmail_messages_search` | Search recent messages — `mailbox`, `query`, `from`, `to`, `subject`, `unread`, `flagged`, `since`, `before`, `limit` |
| `gmail_message_get` | Fetch one message by `mailbox`+`uid` |
| `gmail_message_attachments_save` | Download attachments to `~/.openclaw/inbox/gmail/<mailbox>-<uid>/`. Optional `filenames[]` filter |
| `gmail_message_update` | Set `read` and/or `flagged` |
| `gmail_message_move` | Move to `destinationMailbox` |
| `gmail_message_send` | Send new email (`to`, `cc`, `bcc`, `subject`, `text`/`html`, `attachments`, `confirm`) |
| `gmail_message_reply` | Reply to existing message (`uid`, `text`/`html`, `replyAll`, `attachments`, `confirm`) |

## Send confirmation

By default, `gmail_message_send` and `gmail_message_reply` require an explicit `confirm: true` parameter. This is a guardrail against accidental sends from the agent.

Disable with:

```jsonc
{ "requireExplicitSendConfirmation": false }
```

## Attachments

Inbound attachments are saved by `gmail_message_attachments_save` to:

```
~/.openclaw/inbox/gmail/<mailbox>-<uid>/<filename>
```

Override the base directory with the `attachmentsDir` config option.

## Develop

```sh
npm install
npm run build       # compile src/ -> dist/
npm run typecheck
```

## License

MIT — see [LICENSE](./LICENSE).
