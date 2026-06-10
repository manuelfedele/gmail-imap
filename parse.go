package main

import (
	"bytes"
	"fmt"
	"html"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	msgmail "github.com/emersion/go-message/mail"

	_ "github.com/emersion/go-message/charset"
)

const bodyTextLimit = 4000

// ─── Data model ───────────────────────────────────────────────────────────────

type messageSummary struct {
	Mailbox        string
	UID            uint32
	Subject        string
	From           string
	To             string
	Cc             string
	Date           time.Time
	Preview        string
	Flags          []string
	Unread         bool
	Flagged        bool
	HasAttachments bool
	MessageID      string
}

type attachmentMeta struct {
	Filename    string
	ContentType string
	Size        int
	Content     []byte
}

type fullMessage struct {
	messageSummary
	BodyText    string
	HTML        string
	Attachments []attachmentMeta
	ReplyTo     string
	References  []string
	BodySource  string // "text" | "html-fallback" | "none"
}

// ─── Text utilities ───────────────────────────────────────────────────────────

func truncateText(text string, max int) string {
	if len(text) <= max {
		return text
	}
	return fmt.Sprintf("%s\n…[truncated %d chars]", text[:max], len(text)-max)
}

func compactWhitespace(text string) string {
	return strings.TrimSpace(whitespaceRe.ReplaceAllString(text, " "))
}

var (
	reStyle      = regexp.MustCompile(`(?is)<style.*?</style>`)
	reScript     = regexp.MustCompile(`(?is)<script.*?</script>`)
	reBlockClose = regexp.MustCompile(`(?i)</(?:p|div|li|tr|h[1-6])[^>]*>`)
	reBreak      = regexp.MustCompile(`(?i)<br\s*/?\s*>`)
	reTag        = regexp.MustCompile(`<[^>]+>`)
	reTrailingWS = regexp.MustCompile(`[ \t]+\n`)
	reMultiNL    = regexp.MustCompile(`\n{3,}`)
)

func htmlToText(h string) string {
	if h == "" {
		return ""
	}
	s := reStyle.ReplaceAllString(h, "")
	s = reScript.ReplaceAllString(s, "")
	s = reBlockClose.ReplaceAllString(s, "\n")
	s = reBreak.ReplaceAllString(s, "\n")
	s = reTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = reTrailingWS.ReplaceAllString(s, "\n")
	s = reMultiNL.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

var fsNameRe = regexp.MustCompile(`[/\\\x00]`)

func sanitizeFsName(name, fallback string) string {
	cleaned := fsNameRe.ReplaceAllString(name, "_")
	cleaned = strings.TrimSpace(strings.TrimLeft(cleaned, "."))
	if cleaned == "" || cleaned == "_" {
		return fallback
	}
	if len(cleaned) > 200 {
		cleaned = cleaned[:200]
	}
	return cleaned
}

func formatAddress(addr imap.Address) string {
	email := addr.Addr()
	if addr.Name != "" && email != "" {
		return fmt.Sprintf("%s <%s>", addr.Name, email)
	}
	if email != "" {
		return email
	}
	return addr.Name
}

func formatAddressList(list []imap.Address) string {
	parts := make([]string, 0, len(list))
	for _, a := range list {
		if s := formatAddress(a); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, ", ")
}

func splitRecipients(values []string) []string {
	var out []string
	for _, v := range values {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range values {
		k := strings.ToLower(strings.TrimSpace(v))
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
	}
	return out
}

func parseDateInput(v string) (time.Time, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02", "2006/01/02", "2006-1-2", "2006/1/2"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// ─── Summary / full message construction ─────────────────────────────────────

func hasFlag(flags []imap.Flag, want imap.Flag) bool {
	for _, f := range flags {
		if strings.EqualFold(string(f), string(want)) {
			return true
		}
	}
	return false
}

func flagStrings(flags []imap.Flag) []string {
	out := make([]string, len(flags))
	for i, f := range flags {
		out[i] = string(f)
	}
	return out
}

type fetchedMessage struct {
	UID          uint32
	Flags        []imap.Flag
	Envelope     *imap.Envelope
	InternalDate time.Time
	Source       []byte
	HasAttach    *bool // from bodystructure, when fetched
}

func toSummary(mailbox string, m *fetchedMessage, bodyText string, attachmentCount int, attachmentKnown bool) messageSummary {
	s := messageSummary{
		Mailbox: mailbox,
		UID:     m.UID,
		Date:    m.InternalDate,
		Flags:   flagStrings(m.Flags),
		Unread:  !hasFlag(m.Flags, imap.FlagSeen),
		Flagged: hasFlag(m.Flags, imap.FlagFlagged),
	}
	if env := m.Envelope; env != nil {
		s.Subject = env.Subject
		s.From = formatAddressList(env.From)
		s.To = formatAddressList(env.To)
		s.Cc = formatAddressList(env.Cc)
		s.MessageID = env.MessageID
	}
	preview := compactWhitespace(bodyText)
	if preview == "" {
		preview = compactWhitespace(s.Subject)
	}
	s.Preview = truncateText(preview, 200)
	if attachmentKnown {
		s.HasAttachments = attachmentCount > 0
	} else if m.HasAttach != nil {
		s.HasAttachments = *m.HasAttach
	}
	return s
}

type parsedBody struct {
	Text        string
	HTML        string
	Attachments []attachmentMeta
	ReplyTo     string
	References  []string
}

// parseRawMessage extracts bodies, attachments and threading headers from a raw RFC 822 message.
func parseRawMessage(raw []byte, withContent bool) parsedBody {
	var out parsedBody
	mr, err := msgmail.CreateReader(bytes.NewReader(raw))
	if mr == nil {
		return out
	}
	_ = err // header parse warnings are tolerated as long as a reader exists

	if refs := mr.Header.Get("References"); refs != "" {
		for _, r := range strings.Fields(refs) {
			r = strings.Trim(r, "<>")
			if r != "" {
				out.References = append(out.References, r)
			}
		}
	}
	if rt, err := mr.Header.AddressList("Reply-To"); err == nil && len(rt) > 0 {
		parts := make([]string, 0, len(rt))
		for _, a := range rt {
			parts = append(parts, a.String())
		}
		out.ReplyTo = strings.Join(parts, ", ")
	}

	for {
		p, err := mr.NextPart()
		if err == io.EOF || p == nil {
			break
		}
		if err != nil {
			break
		}
		switch h := p.Header.(type) {
		case *msgmail.InlineHeader:
			ct, params, _ := h.ContentType()
			switch {
			case ct == "text/plain" && out.Text == "":
				b, _ := io.ReadAll(p.Body)
				out.Text = string(b)
			case ct == "text/html" && out.HTML == "":
				b, _ := io.ReadAll(p.Body)
				out.HTML = string(b)
			case !strings.HasPrefix(ct, "text/") && !strings.HasPrefix(ct, "multipart/"):
				// Inline non-text part (e.g. embedded image): report as attachment.
				b, _ := io.ReadAll(p.Body)
				att := attachmentMeta{Filename: params["name"], ContentType: ct, Size: len(b)}
				if withContent {
					att.Content = b
				}
				out.Attachments = append(out.Attachments, att)
			}
		case *msgmail.AttachmentHeader:
			filename, _ := h.Filename()
			ct, _, _ := h.ContentType()
			b, _ := io.ReadAll(p.Body)
			att := attachmentMeta{Filename: filename, ContentType: ct, Size: len(b)}
			if withContent {
				att.Content = b
			}
			out.Attachments = append(out.Attachments, att)
		}
	}
	return out
}

func toFullMessage(mailbox string, m *fetchedMessage) fullMessage {
	parsed := parseRawMessage(m.Source, false)
	bodyText := strings.TrimSpace(parsed.Text)
	bodySource := "text"
	if bodyText == "" {
		bodySource = "none"
		if parsed.HTML != "" {
			if t := htmlToText(parsed.HTML); t != "" {
				bodyText = t
				bodySource = "html-fallback"
			}
		}
	}
	summary := toSummary(mailbox, m, bodyText, len(parsed.Attachments), true)
	return fullMessage{
		messageSummary: summary,
		BodyText:       bodyText,
		HTML:           parsed.HTML,
		Attachments:    parsed.Attachments,
		ReplyTo:        parsed.ReplyTo,
		References:     parsed.References,
		BodySource:     bodySource,
	}
}
