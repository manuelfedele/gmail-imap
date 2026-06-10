package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	netmail "net/mail"
	"os"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// version is overridden at build time via -ldflags "-X main.version=…".
var version = "dev"

var cachedConfig *config

// Config is loaded lazily so a missing config produces a helpful tool error
// instead of a dead server.
func getConfig() (*config, error) {
	if cachedConfig == nil {
		cfg, err := loadConfig()
		if err != nil {
			return nil, err
		}
		cachedConfig = cfg
	}
	return cachedConfig, nil
}

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

func mailboxOrDefault(cfg *config, mailbox string) string {
	if m := strings.TrimSpace(mailbox); m != "" {
		return m
	}
	return cfg.DefaultMailbox
}

// ─── Tool argument types ──────────────────────────────────────────────────────

type listMailboxesArgs struct{}

type searchArgs struct {
	Mailbox       string `json:"mailbox,omitempty" jsonschema:"Mailbox to search (default: configured default mailbox)"`
	Query         string `json:"query,omitempty" jsonschema:"Free text (AND by default, OR for alternation). Inline Gmail-style operators are auto-extracted."`
	From          string `json:"from,omitempty" jsonschema:"Match sender"`
	To            string `json:"to,omitempty" jsonschema:"Match recipient"`
	Subject       string `json:"subject,omitempty" jsonschema:"Match subject"`
	Unread        *bool  `json:"unread,omitempty" jsonschema:"Only unread (true) or only read (false) messages"`
	Flagged       *bool  `json:"flagged,omitempty" jsonschema:"Only starred (true) or only unstarred (false) messages"`
	HasAttachment *bool  `json:"hasAttachment,omitempty" jsonschema:"Only messages with (true) or without (false) attachments"`
	Since         string `json:"since,omitempty" jsonschema:"Lower bound on date (ISO or YYYY-MM-DD)"`
	Before        string `json:"before,omitempty" jsonschema:"Upper bound on date (ISO or YYYY-MM-DD). Use as pagination cursor."`
	Limit         int    `json:"limit,omitempty" jsonschema:"Max results (1-100, default 10)"`
}

type messageRefArgs struct {
	Mailbox string `json:"mailbox,omitempty" jsonschema:"Mailbox containing the message (default: configured default mailbox)"`
	UID     uint32 `json:"uid" jsonschema:"Message UID"`
}

type saveAttachmentsArgs struct {
	Mailbox   string   `json:"mailbox,omitempty" jsonschema:"Mailbox containing the message (default: configured default mailbox)"`
	UID       uint32   `json:"uid" jsonschema:"Message UID"`
	Filenames []string `json:"filenames,omitempty" jsonschema:"Only save attachments with these exact filenames"`
	Subdir    string   `json:"subdir,omitempty" jsonschema:"Nest the per-message folder under this subdirectory of the attachments dir (e.g. a year like 2026)"`
}

type updateArgs struct {
	Mailbox string `json:"mailbox,omitempty" jsonschema:"Mailbox containing the message (default: configured default mailbox)"`
	UID     uint32 `json:"uid" jsonschema:"Message UID"`
	Read    *bool  `json:"read,omitempty" jsonschema:"Mark as read (true) or unread (false)"`
	Flagged *bool  `json:"flagged,omitempty" jsonschema:"Star (true) or unstar (false)"`
}

type moveArgs struct {
	Mailbox            string `json:"mailbox,omitempty" jsonschema:"Source mailbox (default: configured default mailbox)"`
	UID                uint32 `json:"uid" jsonschema:"Message UID"`
	DestinationMailbox string `json:"destinationMailbox" jsonschema:"Destination mailbox path"`
}

type sendArgs struct {
	To          []string          `json:"to" jsonschema:"Recipient addresses"`
	Cc          []string          `json:"cc,omitempty" jsonschema:"CC addresses"`
	Bcc         []string          `json:"bcc,omitempty" jsonschema:"BCC addresses"`
	Subject     string            `json:"subject" jsonschema:"Subject line"`
	Text        string            `json:"text,omitempty" jsonschema:"Plain-text body"`
	HTML        string            `json:"html,omitempty" jsonschema:"HTML body"`
	Attachments []attachmentInput `json:"attachments,omitempty" jsonschema:"Files to attach"`
	Confirm     bool              `json:"confirm,omitempty" jsonschema:"Must be true to actually send when confirmation is required"`
}

type replyArgs struct {
	Mailbox     string            `json:"mailbox,omitempty" jsonschema:"Mailbox containing the original message (default: configured default mailbox)"`
	UID         uint32            `json:"uid" jsonschema:"UID of the message to reply to"`
	Text        string            `json:"text,omitempty" jsonschema:"Plain-text body"`
	HTML        string            `json:"html,omitempty" jsonschema:"HTML body"`
	ReplyAll    bool              `json:"replyAll,omitempty" jsonschema:"Reply to all original recipients (excluding self)"`
	Attachments []attachmentInput `json:"attachments,omitempty" jsonschema:"Files to attach"`
	Confirm     bool              `json:"confirm,omitempty" jsonschema:"Must be true to actually send when confirmation is required"`
}

// ─── Reply helpers ────────────────────────────────────────────────────────────

func extractEmail(formatted string) string {
	if addr, err := netmail.ParseAddress(formatted); err == nil {
		return strings.ToLower(addr.Address)
	}
	return strings.ToLower(strings.TrimSpace(formatted))
}

func splitFormattedList(list string) []string {
	if strings.TrimSpace(list) == "" {
		return nil
	}
	if addrs, err := netmail.ParseAddressList(list); err == nil {
		out := make([]string, 0, len(addrs))
		for _, a := range addrs {
			out = append(out, a.String())
		}
		return out
	}
	return splitRecipients([]string{list})
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	server := mcp.NewServer(&mcp.Implementation{Name: "gmail-imap", Version: version}, nil)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "gmail_mailboxes_list",
		Description: "List the mailboxes (folders/labels) on the configured account.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args listMailboxesArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		mailboxes, err := listMailboxes(cfg)
		if err != nil {
			return nil, nil, err
		}
		return textResult(formatMailboxList(mailboxes)), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "gmail_messages_search",
		Description: "Server-side IMAP search. `query` accepts free text (AND by default) or `OR` for alternation. " +
			"Inline Gmail-style operators are auto-extracted: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, " +
			"`is:starred`, `in:LABEL`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`. Explicit params win over inline operators. " +
			"When no date range is provided, defaults to the last 30 days. Paginate by passing `before` with the `date` " +
			"field of the last seen message.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args searchArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		result, err := searchMessages(cfg, searchParams{
			Mailbox:       args.Mailbox,
			Query:         args.Query,
			From:          args.From,
			To:            args.To,
			Subject:       args.Subject,
			Unread:        args.Unread,
			Flagged:       args.Flagged,
			HasAttachment: args.HasAttachment,
			Since:         args.Since,
			Before:        args.Before,
			Limit:         args.Limit,
		})
		if err != nil {
			return nil, nil, err
		}
		return textResult(formatMessageList(result)), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "gmail_message_get",
		Description: "Fetch one message by UID with full body and attachment metadata. " +
			"HTML-only messages are auto-converted to plain text.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args messageRefArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		message, err := getMessage(cfg, mailboxOrDefault(cfg, args.Mailbox), args.UID)
		if err != nil {
			return nil, nil, err
		}
		return textResult(formatFullMessage(message)), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "gmail_thread_get",
		Description: "Fetch all messages in the same conversation as the given UID, ordered chronologically. " +
			"The thread is resolved via Message-ID/References headers, so it works with Gmail and any other IMAP server.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args messageRefArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		mailbox := mailboxOrDefault(cfg, args.Mailbox)
		messages, err := getThread(cfg, mailbox, args.UID)
		if err != nil {
			return nil, nil, err
		}
		return textResult(formatThread(mailbox, messages)), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name: "gmail_message_attachments_save",
		Description: "Download all (or filtered) attachments of one message to the configured attachments directory. " +
			"Returns absolute paths the agent can read directly. Optional `subdir` nests the per-message folder under " +
			"a subdirectory of the attachments dir (e.g. a year like \"2026\").",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args saveAttachmentsArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		mailbox := mailboxOrDefault(cfg, args.Mailbox)
		result, err := saveAttachments(cfg, mailbox, args.UID, args.Filenames, args.Subdir)
		if err != nil {
			return nil, nil, err
		}
		lines := []string{
			"mailbox: " + mailbox,
			fmt.Sprintf("uid: %d", args.UID),
			"directory: " + result.Directory,
			fmt.Sprintf("saved: %d", len(result.Saved)),
		}
		for _, a := range result.Saved {
			ct := a.ContentType
			if ct == "" {
				ct = "?"
			}
			lines = append(lines, fmt.Sprintf("  - %s (%s, %dB) -> %s", a.Filename, ct, a.Size, a.Path))
		}
		if len(result.Skipped) > 0 {
			lines = append(lines, fmt.Sprintf("skipped: %d", len(result.Skipped)))
			for _, s := range result.Skipped {
				lines = append(lines, fmt.Sprintf("  - %s: %s", s.Filename, s.Reason))
			}
		}
		return textResult(strings.Join(lines, "\n")), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "gmail_message_update",
		Description: "Mark one message as read/unread and/or set/clear its starred state.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args updateArgs) (*mcp.CallToolResult, any, error) {
		if args.Read == nil && args.Flagged == nil {
			return nil, nil, errors.New("provide at least one flag update: read and/or flagged")
		}
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		mailbox := mailboxOrDefault(cfg, args.Mailbox)
		if err := updateMessage(cfg, mailbox, args.UID, args.Read, args.Flagged); err != nil {
			return nil, nil, err
		}
		msg := fmt.Sprintf("Updated %s uid %d", mailbox, args.UID)
		if args.Read != nil {
			msg += fmt.Sprintf(" read=%t", *args.Read)
		}
		if args.Flagged != nil {
			msg += fmt.Sprintf(" flagged=%t", *args.Flagged)
		}
		return textResult(msg), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "gmail_message_move",
		Description: "Move one message to another mailbox.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args moveArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		mailbox := mailboxOrDefault(cfg, args.Mailbox)
		if err := moveMessage(cfg, mailbox, args.UID, args.DestinationMailbox); err != nil {
			return nil, nil, err
		}
		return textResult(fmt.Sprintf("Moved uid %d from %s to %s", args.UID, mailbox, args.DestinationMailbox)), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "gmail_message_send",
		Description: "Send a new email. With requireExplicitSendConfirmation=true (default), must pass confirm=true.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args sendArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		if cfg.RequireExplicitSendConfirmation && !args.Confirm {
			return textResult("Refusing to send: requireExplicitSendConfirmation is enabled and confirm=true was not provided."), nil, nil
		}
		if args.Text == "" && args.HTML == "" {
			return nil, nil, errors.New("provide text and/or html body")
		}
		to := splitRecipients(args.To)
		if len(to) == 0 {
			return nil, nil, errors.New("provide at least one recipient")
		}
		err = sendMessage(ctx, cfg, outgoingMessage{
			To:          to,
			Cc:          splitRecipients(args.Cc),
			Bcc:         splitRecipients(args.Bcc),
			Subject:     args.Subject,
			Text:        args.Text,
			HTML:        args.HTML,
			Attachments: args.Attachments,
		})
		if err != nil {
			return nil, nil, err
		}
		return textResult(fmt.Sprintf("Sent. to=[%s] subject=%q", strings.Join(to, ", "), args.Subject)), nil, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Name:        "gmail_message_reply",
		Description: "Reply to an existing message by UID. replyAll=true CCs all original recipients (excluding self).",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args replyArgs) (*mcp.CallToolResult, any, error) {
		cfg, err := getConfig()
		if err != nil {
			return nil, nil, err
		}
		if cfg.RequireExplicitSendConfirmation && !args.Confirm {
			return textResult("Refusing to reply: requireExplicitSendConfirmation is enabled and confirm=true was not provided."), nil, nil
		}
		if args.Text == "" && args.HTML == "" {
			return nil, nil, errors.New("provide text and/or html body")
		}

		original, err := getMessage(cfg, mailboxOrDefault(cfg, args.Mailbox), args.UID)
		if err != nil {
			return nil, nil, err
		}

		ownAddresses := map[string]bool{
			strings.ToLower(cfg.From):     true,
			strings.ToLower(cfg.Username): true,
		}
		replyTarget := original.ReplyTo
		if replyTarget == "" {
			replyTarget = original.From
		}
		subject := original.Subject
		if !strings.HasPrefix(strings.ToLower(subject), "re:") {
			subject = "Re: " + subject
		}
		var inReplyTo string
		references := append([]string(nil), original.References...)
		if original.MessageID != "" {
			id := strings.Trim(original.MessageID, "<>")
			inReplyTo = "<" + id + ">"
			references = append(references, id)
		}
		references = uniqueStrings(references)

		var to, cc []string
		if args.ReplyAll {
			var all []string
			for _, chunk := range []string{replyTarget, original.To, original.Cc} {
				all = append(all, splitFormattedList(chunk)...)
			}
			all = uniqueStrings(all)
			filtered := all[:0]
			for _, addr := range all {
				if !ownAddresses[extractEmail(addr)] {
					filtered = append(filtered, addr)
				}
			}
			if len(filtered) == 0 {
				return nil, nil, errors.New("replyAll produced no recipients other than yourself")
			}
			to = filtered[:1]
			cc = filtered[1:]
		} else {
			if replyTarget == "" {
				return nil, nil, errors.New("original message has no sender to reply to")
			}
			to = []string{replyTarget}
		}

		text := args.Text
		if text != "" && original.BodyText != "" {
			quotedLines := strings.Split(original.BodyText, "\n")
			for i, l := range quotedLines {
				quotedLines[i] = "> " + l
			}
			text = fmt.Sprintf("%s\n\nOn %s, %s wrote:\n%s", text, formatDate(original.Date), original.From, strings.Join(quotedLines, "\n"))
		}

		err = sendMessage(ctx, cfg, outgoingMessage{
			To:          to,
			Cc:          cc,
			Subject:     subject,
			Text:        text,
			HTML:        args.HTML,
			Attachments: args.Attachments,
			InReplyTo:   inReplyTo,
			References:  references,
		})
		if err != nil {
			return nil, nil, err
		}
		return textResult(fmt.Sprintf("Replied. to=[%s] subject=%q", strings.Join(to, ", "), subject)), nil, nil
	})

	log.SetOutput(os.Stderr)
	if err := server.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("gmail-imap fatal: %v", err)
	}
}
