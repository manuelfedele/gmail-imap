package main

import (
	"fmt"
	"strings"
	"time"
)

func formatMailboxList(mailboxes []mailboxInfo) string {
	if len(mailboxes) == 0 {
		return "(no mailboxes)"
	}
	lines := make([]string, 0, len(mailboxes))
	for _, mb := range mailboxes {
		line := "- " + mb.Path
		if len(mb.Attrs) > 0 {
			line += fmt.Sprintf(" [%s]", strings.Join(mb.Attrs, ","))
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func formatDate(t time.Time) string {
	if t.IsZero() {
		return "?"
	}
	return t.UTC().Format(time.RFC3339)
}

func summaryFlagTags(m messageSummary) string {
	var tags []string
	if m.Unread {
		tags = append(tags, "unread")
	}
	if m.Flagged {
		tags = append(tags, "flagged")
	}
	if m.HasAttachments {
		tags = append(tags, "attach")
	}
	return strings.Join(tags, ",")
}

func formatMessageList(result searchResult) string {
	info := result.Info
	if len(result.Messages) == 0 {
		if info.MatchedTotal == 0 {
			return "(no messages match)"
		}
		return fmt.Sprintf("(no messages after client-side filters; matched=%d, scanned=%d, filtered=%d)",
			info.MatchedTotal, info.Scanned, info.FilteredClientSide)
	}

	headerParts := []string{
		fmt.Sprintf("%d of %d server matches", len(result.Messages), info.MatchedTotal),
		"mode=" + info.FetchMode,
		fmt.Sprintf("scanned=%d", info.Scanned),
		fmt.Sprintf("filtered=%d", info.FilteredClientSide),
	}
	if info.EffectiveSince != "" {
		headerParts = append(headerParts, "since="+info.EffectiveSince)
	}
	if len(info.PickedOperators) > 0 {
		headerParts = append(headerParts, fmt.Sprintf("extracted=[%s]", strings.Join(info.PickedOperators, " ")))
	}
	if info.EffectiveQuery != "" {
		headerParts = append(headerParts, fmt.Sprintf("q=%q", info.EffectiveQuery))
	}
	if info.PartialReason != "" {
		headerParts = append(headerParts, fmt.Sprintf("PARTIAL: %s (%d/%d)",
			info.PartialReason, info.PartialProcessed, info.PartialProcessed+info.PartialRemaining))
	}

	blocks := make([]string, 0, len(result.Messages))
	for _, m := range result.Messages {
		head := fmt.Sprintf("uid %d [%s]", m.UID, m.Mailbox)
		if tags := summaryFlagTags(m); tags != "" {
			head += fmt.Sprintf(" (%s)", tags)
		}
		blocks = append(blocks, strings.Join([]string{
			head,
			"  date: " + formatDate(m.Date),
			"  from: " + m.From,
			"  subject: " + m.Subject,
			"  preview: " + m.Preview,
		}, "\n"))
	}

	return "# " + strings.Join(headerParts, ", ") + "\n\n" + strings.Join(blocks, "\n\n")
}

func formatFullMessage(m fullMessage) string {
	lines := []string{
		fmt.Sprintf("uid: %d", m.UID),
		"mailbox: " + m.Mailbox,
		"date: " + formatDate(m.Date),
		"from: " + m.From,
		"to: " + m.To,
	}
	if m.Cc != "" {
		lines = append(lines, "cc: "+m.Cc)
	}
	if m.ReplyTo != "" {
		lines = append(lines, "reply-to: "+m.ReplyTo)
	}
	flags := "(none)"
	if len(m.Flags) > 0 {
		flags = strings.Join(m.Flags, ", ")
	}
	lines = append(lines, "subject: "+m.Subject, "flags: "+flags)
	if len(m.Attachments) > 0 {
		parts := make([]string, 0, len(m.Attachments))
		for _, a := range m.Attachments {
			name := a.Filename
			if name == "" {
				name = a.ContentType
			}
			if name == "" {
				name = "attachment"
			}
			if a.Size > 0 {
				name += fmt.Sprintf(" (%dB)", a.Size)
			}
			parts = append(parts, name)
		}
		lines = append(lines, "attachments: "+strings.Join(parts, ", "))
	} else {
		lines = append(lines, "attachments: (none)")
	}
	bodyHeader := "body:"
	switch m.BodySource {
	case "html-fallback":
		bodyHeader = "body (extracted from html):"
	case "none":
		bodyHeader = "body: (no text or html)"
	}
	body := m.BodyText
	if body == "" {
		body = "(empty)"
	}
	lines = append(lines, "", bodyHeader, truncateText(body, bodyTextLimit))
	return strings.Join(lines, "\n")
}

func formatThread(mailbox string, messages []fullMessage) string {
	lines := []string{fmt.Sprintf("Thread in %s — %d message(s)", mailbox, len(messages)), ""}
	for i, m := range messages {
		head := fmt.Sprintf("--- [%d/%d] uid %d", i+1, len(messages), m.UID)
		if tags := summaryFlagTags(m.messageSummary); tags != "" {
			head += fmt.Sprintf(" (%s)", tags)
		}
		body := m.BodyText
		if body == "" {
			body = "(empty)"
		}
		lines = append(lines,
			head,
			"date: "+formatDate(m.Date),
			"from: "+m.From,
			"to: "+m.To,
			"subject: "+m.Subject,
			"",
			truncateText(body, 1500),
		)
	}
	return strings.Join(lines, "\n")
}
