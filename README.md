# gmail-imap

> A single-binary [MCP](https://modelcontextprotocol.io) server for Gmail (and any IMAP/SMTP mailbox) — with **first-class attachment download**. Written in Go, no runtime dependencies.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![build](https://github.com/manuelfedele/gmail-imap/actions/workflows/build.yml/badge.svg)](https://github.com/manuelfedele/gmail-imap/actions/workflows/build.yml)

**The attachment story is the headline.** Most email integrations for AI agents stop at metadata: they tell the model "this message has 3 attachments" and that's it. This one writes the actual files to disk and hands the agent absolute paths it can pipe into every other tool — Read, PDF/XLSX/DOCX skills, OCR, your own scripts. Invoices, contracts, photos, CSVs — they land somewhere the agent can act on them.

Plus the rest of the boring-but-essential mailbox surface: read, search, send, reply with proper threading, star, move. No SaaS dependencies, no OAuth dance — just an App Password.

```text
You: "Open the latest email from my accountant and download the PDFs."

Claude → gmail_messages_search { from: "accountant@firm.com", limit: 1 }
Claude → gmail_message_attachments_save { uid: 4128 }
         ↳ saved 2 files to ~/.gmail-imap/attachments/INBOX-4128/
             - Invoice_2026_05.pdf  (124 KB)
             - Receipts_April.pdf   (812 KB)
Claude → Read("~/.gmail-imap/attachments/INBOX-4128/Invoice_2026_05.pdf")
         ↳ "Total due: €2,340. Payment by 2026-05-31. Reference: INV-2845."
```

---

## Install

Download a prebuilt binary from the [build workflow artifacts](https://github.com/manuelfedele/gmail-imap/actions/workflows/build.yml) — Linux, macOS and Windows, amd64 and arm64 — or build from source:

```sh
go build -o gmail-imap .
# or
go install github.com/manuelfedele/gmail-imap@latest
```

## Configuration

Generate a Gmail App Password at <https://myaccount.google.com/apppasswords> (requires 2FA).

**Option 1 — config file** at `~/.gmail-imap/config.json` (override the path with `GMAIL_IMAP_CONFIG`):

```json
{
  "username": "you@gmail.com",
  "appPassword": "xxxxxxxxxxxxxxxx",
  "fromName": "Your Name"
}
```

All fields:

| Field | Default | Notes |
| --- | --- | --- |
| `username` | — | required |
| `appPassword` | — | required; spaces are stripped |
| `from` | `username` | sender address |
| `fromName` | — | display name on sent mail |
| `replyTo` | — | Reply-To header on sent mail |
| `imap.host` / `imap.port` / `imap.secure` | `imap.gmail.com` / `993` / `true` | |
| `smtp.host` / `smtp.port` / `smtp.secure` | `smtp.gmail.com` / `465` / `true` | `secure=false` uses STARTTLS |
| `defaultMailbox` | `INBOX` | |
| `defaultSearchLimit` | `10` | |
| `attachmentsDir` | `~/.gmail-imap/attachments` | |
| `requireExplicitSendConfirmation` | `true` | send/reply require `confirm=true` |

**Option 2 — environment variables** (these win over the config file): `GMAIL_USERNAME`, `GMAIL_APP_PASSWORD`, `GMAIL_FROM`, `GMAIL_FROM_NAME`, `GMAIL_REPLY_TO`, `GMAIL_IMAP_HOST`, `GMAIL_IMAP_PORT`, `GMAIL_IMAP_SECURE`, `GMAIL_SMTP_HOST`, `GMAIL_SMTP_PORT`, `GMAIL_SMTP_SECURE`, `GMAIL_DEFAULT_MAILBOX`, `GMAIL_DEFAULT_SEARCH_LIMIT`, `GMAIL_ATTACHMENTS_DIR`, `GMAIL_REQUIRE_SEND_CONFIRMATION`.

Works with any IMAP/SMTP provider that supports password auth — point `imap.host`/`smtp.host` at Fastmail, iCloud, your own server, etc.

## Registering the server

The server speaks MCP over stdio. With Claude Code:

```sh
claude mcp add gmail-imap -- /path/to/gmail-imap
```

Or in any MCP client configuration:

```json
{
  "mcpServers": {
    "gmail-imap": {
      "command": "/path/to/gmail-imap"
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `gmail_mailboxes_list` | List folders/labels |
| `gmail_messages_search` | Server-side search; free text plus inline Gmail-style operators; defaults to the last 30 days when no date filter is given |
| `gmail_message_get` | Full message by UID — body (HTML auto-converted to text when needed) and attachment metadata |
| `gmail_thread_get` | All messages in the same conversation, chronological |
| `gmail_message_attachments_save` | Save attachments to disk; returns absolute paths |
| `gmail_message_update` | Mark read/unread, star/unstar |
| `gmail_message_move` | Move a message to another mailbox |
| `gmail_message_send` | Send a new email (guarded by `confirm`) |
| `gmail_message_reply` | Reply / reply-all with quoting and proper `In-Reply-To`/`References` headers (guarded by `confirm`) |

### Search syntax

`query` accepts free text (terms are ANDed, `OR` for alternation) and Gmail-style operators which are extracted automatically:

```text
invoice from:billing@example.com is:unread after:2026-01-01 has:attachment
```

Recognized operators: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:read`, `is:starred`, `in:LABEL`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`. Explicit tool parameters win over inline operators. Paginate by passing `before` with the `date` of the last seen message.

Threading is resolved via standard `Message-ID`/`References` headers, so `gmail_thread_get` works against Gmail and any other IMAP server alike.

## Building all platforms

The [build workflow](.github/workflows/build.yml) runs `go vet` / `go test` and cross-compiles static binaries (`CGO_ENABLED=0`) for linux, darwin and windows on amd64 and arm64 — on every push to `main`, every tag and every pull request — uploading each binary as a workflow artifact.

```sh
# local equivalent
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o dist/gmail-imap-linux-amd64 .
```

## License

MIT
