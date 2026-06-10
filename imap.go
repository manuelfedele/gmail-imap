package main

import (
	"crypto/tls"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

const (
	imapConnectTimeout = 10 * time.Second
	imapRetryAttempts  = 3
)

var imapRetryDelays = []time.Duration{100 * time.Millisecond, 500 * time.Millisecond, 2 * time.Second}

var retryableErrRe = regexp.MustCompile(`(?i)connection|timed out|refused|reset|unreachable|broken pipe|EOF|socket|network`)

func dialIMAP(cfg *config) (*imapclient.Client, error) {
	addr := net.JoinHostPort(cfg.IMAP.Host, fmt.Sprintf("%d", cfg.IMAP.Port))
	dialer := &net.Dialer{Timeout: imapConnectTimeout}
	var conn net.Conn
	var err error
	if cfg.IMAP.Secure {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: cfg.IMAP.Host})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return nil, fmt.Errorf("IMAP connect to %s failed: %w", addr, err)
	}
	client := imapclient.New(conn, nil)
	if err := client.Login(cfg.Username, cfg.AppPassword).Wait(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("IMAP login failed: %w", err)
	}
	return client, nil
}

// withIMAP runs fn with a fresh, logged-in IMAP client, retrying transient connection errors.
func withIMAP[T any](cfg *config, fn func(c *imapclient.Client) (T, error)) (T, error) {
	var zero T
	var lastErr error
	for attempt := 0; attempt < imapRetryAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(imapRetryDelays[attempt-1])
		}
		client, err := dialIMAP(cfg)
		if err != nil {
			lastErr = err
			if retryableErrRe.MatchString(err.Error()) && attempt < imapRetryAttempts-1 {
				continue
			}
			return zero, err
		}
		result, err := fn(client)
		logoutErr := client.Logout().Wait()
		_ = logoutErr // best-effort
		if err != nil {
			lastErr = err
			if retryableErrRe.MatchString(err.Error()) && attempt < imapRetryAttempts-1 {
				continue
			}
			return zero, err
		}
		return result, nil
	}
	return zero, lastErr
}

func selectMailbox(c *imapclient.Client, mailbox string, readOnly bool) error {
	_, err := c.Select(mailbox, &imap.SelectOptions{ReadOnly: readOnly}).Wait()
	if err != nil {
		return fmt.Errorf("cannot open mailbox %q: %w", mailbox, err)
	}
	return nil
}

// ─── Mailboxes ────────────────────────────────────────────────────────────────

type mailboxInfo struct {
	Path  string
	Attrs []string
}

func listMailboxes(cfg *config) ([]mailboxInfo, error) {
	return withIMAP(cfg, func(c *imapclient.Client) ([]mailboxInfo, error) {
		boxes, err := c.List("", "*", nil).Collect()
		if err != nil {
			return nil, err
		}
		out := make([]mailboxInfo, 0, len(boxes))
		for _, mb := range boxes {
			attrs := make([]string, 0, len(mb.Attrs))
			for _, a := range mb.Attrs {
				attrs = append(attrs, string(a))
			}
			out = append(out, mailboxInfo{Path: mb.Mailbox, Attrs: attrs})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
		return out, nil
	})
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

func bodyStructureHasAttachment(bs imap.BodyStructure) bool {
	found := false
	bs.Walk(func(path []int, part imap.BodyStructure) bool {
		if found {
			return false
		}
		if disp := part.Disposition(); disp != nil && strings.EqualFold(disp.Value, "attachment") {
			found = true
			return false
		}
		mt := strings.ToLower(part.MediaType())
		if disp := part.Disposition(); disp != nil && disp.Params["filename"] != "" &&
			!strings.HasPrefix(mt, "multipart/") && !strings.HasPrefix(mt, "text/") {
			found = true
			return false
		}
		return true
	})
	return found
}

func collectFetched(buf *imapclient.FetchMessageBuffer) *fetchedMessage {
	m := &fetchedMessage{
		UID:          uint32(buf.UID),
		Flags:        buf.Flags,
		Envelope:     buf.Envelope,
		InternalDate: buf.InternalDate,
	}
	for _, section := range buf.BodySection {
		if len(section.Bytes) > 0 {
			m.Source = section.Bytes
			break
		}
	}
	if buf.BodyStructure != nil {
		has := bodyStructureHasAttachment(buf.BodyStructure)
		m.HasAttach = &has
	}
	return m
}

func uidSetOf(uids ...uint32) imap.UIDSet {
	var set imap.UIDSet
	for _, u := range uids {
		set.AddNum(imap.UID(u))
	}
	return set
}

type fetchExtras struct {
	Source        bool
	BodyStructure bool
}

func fetchMessages(c *imapclient.Client, uids []uint32, extras fetchExtras, deadline time.Time) ([]*fetchedMessage, bool, error) {
	opts := &imap.FetchOptions{UID: true, Envelope: true, Flags: true, InternalDate: true}
	if extras.Source {
		opts.BodySection = []*imap.FetchItemBodySection{{Peek: true}}
	}
	if extras.BodyStructure {
		opts.BodyStructure = &imap.FetchItemBodyStructure{Extended: true}
	}
	cmd := c.Fetch(uidSetOf(uids...), opts)
	var out []*fetchedMessage
	timedOut := false
	for {
		if !deadline.IsZero() && time.Now().After(deadline) {
			timedOut = true
			break
		}
		msg := cmd.Next()
		if msg == nil {
			break
		}
		buf, err := msg.Collect()
		if err != nil {
			_ = cmd.Close()
			return out, timedOut, err
		}
		out = append(out, collectFetched(buf))
	}
	if err := cmd.Close(); err != nil && !timedOut {
		return out, timedOut, err
	}
	return out, timedOut, nil
}

func fetchOneMessage(c *imapclient.Client, uid uint32, extras fetchExtras) (*fetchedMessage, error) {
	msgs, _, err := fetchMessages(c, []uint32{uid}, extras, time.Time{})
	if err != nil {
		return nil, err
	}
	if len(msgs) == 0 {
		return nil, fmt.Errorf("message uid %d not found", uid)
	}
	return msgs[0], nil
}

// ─── Single message / thread ─────────────────────────────────────────────────

func getMessage(cfg *config, mailbox string, uid uint32) (fullMessage, error) {
	return withIMAP(cfg, func(c *imapclient.Client) (fullMessage, error) {
		if err := selectMailbox(c, mailbox, true); err != nil {
			return fullMessage{}, err
		}
		m, err := fetchOneMessage(c, uid, fetchExtras{Source: true})
		if err != nil {
			return fullMessage{}, err
		}
		return toFullMessage(mailbox, m), nil
	})
}

// orCriteria combines criteria with OR, folding the binary OR pairs the protocol requires.
func orCriteria(criteria []imap.SearchCriteria) imap.SearchCriteria {
	if len(criteria) == 1 {
		return criteria[0]
	}
	acc := criteria[len(criteria)-1]
	for i := len(criteria) - 2; i >= 0; i-- {
		acc = imap.SearchCriteria{Or: [][2]imap.SearchCriteria{{criteria[i], acc}}}
	}
	return acc
}

// getThread resolves the conversation containing the given UID via Message-ID/References
// headers (standard IMAP; works on Gmail and any other server).
func getThread(cfg *config, mailbox string, uid uint32) ([]fullMessage, error) {
	return withIMAP(cfg, func(c *imapclient.Client) ([]fullMessage, error) {
		if err := selectMailbox(c, mailbox, true); err != nil {
			return nil, err
		}
		seed, err := fetchOneMessage(c, uid, fetchExtras{Source: true})
		if err != nil {
			return nil, err
		}
		seedParsed := parseRawMessage(seed.Source, false)
		ids := seedParsed.References
		if seed.Envelope != nil && seed.Envelope.MessageID != "" {
			ids = append(ids, seed.Envelope.MessageID)
		}
		ids = uniqueStrings(ids)
		if len(ids) == 0 {
			// No Message-ID at all: the thread is just this message.
			return []fullMessage{toFullMessage(mailbox, seed)}, nil
		}

		var alternatives []imap.SearchCriteria
		for _, id := range ids {
			alternatives = append(alternatives,
				imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Message-Id", Value: id}}},
				imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "References", Value: id}}},
			)
		}
		criteria := orCriteria(alternatives)
		data, err := c.UIDSearch(&criteria, nil).Wait()
		if err != nil {
			return nil, fmt.Errorf("thread search failed: %w", err)
		}
		uids := make([]uint32, 0)
		seen := map[uint32]bool{}
		for _, u := range data.AllUIDs() {
			if !seen[uint32(u)] {
				seen[uint32(u)] = true
				uids = append(uids, uint32(u))
			}
		}
		if !seen[uid] {
			uids = append(uids, uid)
		}

		msgs, _, err := fetchMessages(c, uids, fetchExtras{Source: true}, time.Time{})
		if err != nil {
			return nil, err
		}
		full := make([]fullMessage, 0, len(msgs))
		for _, m := range msgs {
			full = append(full, toFullMessage(mailbox, m))
		}
		sort.Slice(full, func(i, j int) bool { return full[i].Date.Before(full[j].Date) })
		return full, nil
	})
}

// ─── Flags / move ─────────────────────────────────────────────────────────────

func updateMessage(cfg *config, mailbox string, uid uint32, read, flagged *bool) error {
	_, err := withIMAP(cfg, func(c *imapclient.Client) (struct{}, error) {
		if err := selectMailbox(c, mailbox, false); err != nil {
			return struct{}{}, err
		}
		apply := func(value bool, flag imap.Flag) error {
			op := imap.StoreFlagsAdd
			if !value {
				op = imap.StoreFlagsDel
			}
			return c.Store(uidSetOf(uid), &imap.StoreFlags{Op: op, Silent: true, Flags: []imap.Flag{flag}}, nil).Close()
		}
		if read != nil {
			if err := apply(*read, imap.FlagSeen); err != nil {
				return struct{}{}, err
			}
		}
		if flagged != nil {
			if err := apply(*flagged, imap.FlagFlagged); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	})
	return err
}

func moveMessage(cfg *config, mailbox string, uid uint32, destination string) error {
	_, err := withIMAP(cfg, func(c *imapclient.Client) (struct{}, error) {
		if err := selectMailbox(c, mailbox, false); err != nil {
			return struct{}{}, err
		}
		_, err := c.Move(uidSetOf(uid), destination).Wait()
		return struct{}{}, err
	})
	return err
}

// ─── Attachments ──────────────────────────────────────────────────────────────

type savedAttachment struct {
	Filename    string
	Path        string
	ContentType string
	Size        int
}

type skippedAttachment struct {
	Filename string
	Reason   string
}

type saveAttachmentsResult struct {
	Directory string
	Saved     []savedAttachment
	Skipped   []skippedAttachment
}

func saveAttachments(cfg *config, mailbox string, uid uint32, filenames []string, subdir string) (saveAttachmentsResult, error) {
	return withIMAP(cfg, func(c *imapclient.Client) (saveAttachmentsResult, error) {
		var result saveAttachmentsResult
		if err := selectMailbox(c, mailbox, true); err != nil {
			return result, err
		}
		m, err := fetchOneMessage(c, uid, fetchExtras{Source: true})
		if err != nil {
			return result, err
		}
		parsed := parseRawMessage(m.Source, true)

		filter := map[string]bool{}
		for _, f := range filenames {
			filter[f] = true
		}

		baseDir := cfg.AttachmentsDir
		if subdir != "" {
			baseDir = filepath.Join(baseDir, sanitizeFsName(subdir, "misc"))
		}
		targetDir := filepath.Join(baseDir, fmt.Sprintf("%s-%d", sanitizeFsName(mailbox, "INBOX"), uid))
		if err := os.MkdirAll(targetDir, 0o755); err != nil {
			return result, err
		}
		result.Directory = targetDir

		for i, att := range parsed.Attachments {
			filename := sanitizeFsName(att.Filename, fmt.Sprintf("attachment-%d", i+1))
			if len(filter) > 0 && att.Filename != "" && !filter[att.Filename] {
				result.Skipped = append(result.Skipped, skippedAttachment{Filename: att.Filename, Reason: "not in filenames filter"})
				continue
			}
			if len(att.Content) == 0 {
				result.Skipped = append(result.Skipped, skippedAttachment{Filename: filename, Reason: "empty content"})
				continue
			}
			path := filepath.Join(targetDir, filename)
			if err := os.WriteFile(path, att.Content, 0o644); err != nil {
				return result, err
			}
			result.Saved = append(result.Saved, savedAttachment{Filename: filename, Path: path, ContentType: att.ContentType, Size: len(att.Content)})
		}
		return result, nil
	})
}
