package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

const (
	defaultSinceDays     = 30
	fetchCandidatesCap   = 1000
	searchFetchTimeout   = 30 * time.Second
	maxSearchResultLimit = 100
)

type searchParams struct {
	Mailbox       string
	Query         string
	From          string
	To            string
	Subject       string
	Unread        *bool
	Flagged       *bool
	HasAttachment *bool
	Since         string
	Before        string
	Limit         int
}

type searchInfo struct {
	MatchedTotal       int
	Scanned            int
	FilteredClientSide int
	FetchMode          string // "envelope" | "bodyStructure" | "source"
	EffectiveSince     string
	PartialReason      string
	PartialProcessed   int
	PartialRemaining   int
	PickedOperators    []string
	EffectiveQuery     string
}

type searchResult struct {
	Messages []messageSummary
	Info     searchInfo
}

// ─── Inline Gmail-style operator extraction ───────────────────────────────────

var operatorRe = regexp.MustCompile(`(\w+):(?:"([^"]+)"|(\S+))`)
var gmailSlashDateRe = regexp.MustCompile(`^\d{4}/\d{1,2}/\d{1,2}$`)

func normalizeGmailDate(v string) string {
	if gmailSlashDateRe.MatchString(v) {
		return strings.ReplaceAll(v, "/", "-")
	}
	return v
}

// extractOperators pulls Gmail-style operators (from:, is:unread, …) out of a free-text
// query, returning the leftover text, the parsed fields, and the operators consumed.
func extractOperators(query string) (remaining string, parsed searchParams, picked []string) {
	type span struct{ start, end int }
	var consumedSpans []span

	for _, m := range operatorRe.FindAllStringSubmatchIndex(query, -1) {
		key := strings.ToLower(query[m[2]:m[3]])
		var value string
		if m[4] >= 0 {
			value = query[m[4]:m[5]]
		} else {
			value = query[m[6]:m[7]]
		}
		consumed := false
		switch key {
		case "from":
			if parsed.From == "" {
				parsed.From = value
				consumed = true
			}
		case "to":
			if parsed.To == "" {
				parsed.To = value
				consumed = true
			}
		case "subject":
			if parsed.Subject == "" {
				parsed.Subject = value
				consumed = true
			}
		case "has":
			if strings.Contains(strings.ToLower(value), "attachment") {
				t := true
				parsed.HasAttachment = &t
				consumed = true
			}
		case "is":
			switch strings.ToLower(value) {
			case "unread":
				t := true
				parsed.Unread = &t
				consumed = true
			case "read":
				f := false
				parsed.Unread = &f
				consumed = true
			case "flagged", "starred":
				t := true
				parsed.Flagged = &t
				consumed = true
			}
		case "in", "label":
			if parsed.Mailbox == "" {
				parsed.Mailbox = value
				consumed = true
			}
		case "before":
			if parsed.Before == "" {
				parsed.Before = normalizeGmailDate(value)
				consumed = true
			}
		case "after", "since":
			if parsed.Since == "" {
				parsed.Since = normalizeGmailDate(value)
				consumed = true
			}
		}
		if consumed {
			consumedSpans = append(consumedSpans, span{m[0], m[1]})
			picked = append(picked, fmt.Sprintf("%s:%s", key, value))
		}
	}

	var sb strings.Builder
	cursor := 0
	for _, s := range consumedSpans {
		if s.start > cursor {
			sb.WriteString(query[cursor:s.start])
		}
		cursor = s.end
	}
	if cursor < len(query) {
		sb.WriteString(query[cursor:])
	}
	remaining = compactWhitespace(sb.String())
	return remaining, parsed, picked
}

// parseQueryGroups splits free text into OR-separated groups of AND terms.
func parseQueryGroups(query string) [][]string {
	if strings.TrimSpace(query) == "" {
		return nil
	}
	var groups [][]string
	orRe := regexp.MustCompile(`(?i)\s+OR\s+`)
	for _, g := range orRe.Split(strings.TrimSpace(query), -1) {
		var terms []string
		for _, t := range strings.Fields(g) {
			if !strings.EqualFold(t, "AND") && !strings.EqualFold(t, "OR") {
				terms = append(terms, t)
			}
		}
		if len(terms) > 0 {
			groups = append(groups, terms)
		}
	}
	return groups
}

func resolveSearchParams(params searchParams) (searchParams, []string) {
	effective := params
	var picked []string

	if params.Query != "" {
		remaining, parsed, p := extractOperators(params.Query)
		if len(p) > 0 {
			picked = p
			if effective.From == "" {
				effective.From = parsed.From
			}
			if effective.To == "" {
				effective.To = parsed.To
			}
			if effective.Subject == "" {
				effective.Subject = parsed.Subject
			}
			if effective.Unread == nil {
				effective.Unread = parsed.Unread
			}
			if effective.Flagged == nil {
				effective.Flagged = parsed.Flagged
			}
			if effective.HasAttachment == nil {
				effective.HasAttachment = parsed.HasAttachment
			}
			if effective.Since == "" {
				effective.Since = parsed.Since
			}
			if effective.Before == "" {
				effective.Before = parsed.Before
			}
			if effective.Mailbox == "" {
				effective.Mailbox = parsed.Mailbox
			}
			effective.Query = remaining
		}
	}

	// Default to the last defaultSinceDays when no temporal filter — prevents full-mailbox scans.
	if effective.Since == "" && effective.Before == "" {
		effective.Since = time.Now().AddDate(0, 0, -defaultSinceDays).Format("2006-01-02")
	}

	return effective, picked
}

func buildServerCriteria(params searchParams) *imap.SearchCriteria {
	criteria := &imap.SearchCriteria{}
	addHeader := func(key, value string) {
		criteria.Header = append(criteria.Header, imap.SearchCriteriaHeaderField{Key: key, Value: value})
	}
	if params.From != "" {
		addHeader("From", params.From)
	}
	if params.To != "" {
		addHeader("To", params.To)
	}
	if params.Subject != "" {
		addHeader("Subject", params.Subject)
	}
	if params.Unread != nil {
		if *params.Unread {
			criteria.NotFlag = append(criteria.NotFlag, imap.FlagSeen)
		} else {
			criteria.Flag = append(criteria.Flag, imap.FlagSeen)
		}
	}
	if params.Flagged != nil {
		if *params.Flagged {
			criteria.Flag = append(criteria.Flag, imap.FlagFlagged)
		} else {
			criteria.NotFlag = append(criteria.NotFlag, imap.FlagFlagged)
		}
	}
	if t, ok := parseDateInput(params.Since); ok {
		criteria.Since = t
	}
	if t, ok := parseDateInput(params.Before); ok {
		criteria.Before = t
	}
	return criteria
}

func chooseFetchMode(queryGroups [][]string, hasAttachmentFilter bool) string {
	if len(queryGroups) > 0 {
		return "source" // need body text for client-side matching
	}
	if hasAttachmentFilter {
		return "bodyStructure" // attachment detection without full source
	}
	return "envelope"
}

func searchMessages(cfg *config, params searchParams) (searchResult, error) {
	effective, picked := resolveSearchParams(params)
	mailbox := strings.TrimSpace(effective.Mailbox)
	if mailbox == "" {
		mailbox = cfg.DefaultMailbox
	}
	limit := effective.Limit
	if limit <= 0 {
		limit = cfg.DefaultSearchLimit
	}
	if limit > maxSearchResultLimit {
		limit = maxSearchResultLimit
	}
	queryGroups := parseQueryGroups(effective.Query)
	fetchMode := chooseFetchMode(queryGroups, effective.HasAttachment != nil)

	return withIMAP(cfg, func(c *imapclient.Client) (searchResult, error) {
		var result searchResult
		if err := selectMailbox(c, mailbox, true); err != nil {
			return result, err
		}

		data, err := c.UIDSearch(buildServerCriteria(effective), nil).Wait()
		if err != nil {
			return result, fmt.Errorf("IMAP search failed: %w", err)
		}
		var matched []uint32
		for _, u := range data.AllUIDs() {
			matched = append(matched, uint32(u))
		}

		result.Info = searchInfo{
			MatchedTotal:    len(matched),
			FetchMode:       fetchMode,
			EffectiveSince:  effective.Since,
			PickedOperators: picked,
			EffectiveQuery:  effective.Query,
		}
		if len(matched) == 0 {
			return result, nil
		}

		// Cap to avoid protocol and memory issues. When capped, take the highest UIDs
		// (most recently arrived in folder) as the best approximation of recency.
		fetchTargets := matched
		capped := len(matched) > fetchCandidatesCap
		if capped {
			sorted := append([]uint32(nil), matched...)
			sort.Slice(sorted, func(i, j int) bool { return sorted[i] > sorted[j] })
			fetchTargets = sorted[:fetchCandidatesCap]
		}

		extras := fetchExtras{
			Source:        fetchMode == "source",
			BodyStructure: fetchMode == "bodyStructure",
		}
		deadline := time.Now().Add(searchFetchTimeout)
		fetched, timedOut, err := fetchMessages(c, fetchTargets, extras, deadline)
		if err != nil && len(fetched) == 0 {
			return result, err
		}

		var matches []messageSummary
		for _, m := range fetched {
			result.Info.Scanned++

			bodyText := ""
			attachmentCount := 0
			attachmentKnown := false
			if fetchMode == "source" && len(m.Source) > 0 {
				parsed := parseRawMessage(m.Source, false)
				bodyText = strings.TrimSpace(parsed.Text)
				if bodyText == "" && parsed.HTML != "" {
					bodyText = htmlToText(parsed.HTML)
				}
				attachmentCount = len(parsed.Attachments)
				attachmentKnown = true
			} else if fetchMode == "bodyStructure" && m.HasAttach != nil {
				if *m.HasAttach {
					attachmentCount = 1
				}
				attachmentKnown = true
			}

			summary := toSummary(mailbox, m, bodyText, attachmentCount, attachmentKnown)

			if len(queryGroups) > 0 {
				haystack := strings.ToLower(strings.Join([]string{summary.Subject, summary.From, summary.To, summary.Cc, bodyText}, " "))
				if !matchesQueryGroups(haystack, queryGroups) {
					result.Info.FilteredClientSide++
					continue
				}
			}
			if effective.HasAttachment != nil && attachmentKnown && *effective.HasAttachment != (attachmentCount > 0) {
				result.Info.FilteredClientSide++
				continue
			}

			matches = append(matches, summary)
		}

		// Sort by internal date descending — ordering by arrival time.
		sort.Slice(matches, func(i, j int) bool { return matches[i].Date.After(matches[j].Date) })
		if len(matches) > limit {
			matches = matches[:limit]
		}
		result.Messages = matches

		if timedOut {
			result.Info.PartialReason = fmt.Sprintf("fetch loop exceeded %s", searchFetchTimeout)
			result.Info.PartialProcessed = result.Info.Scanned
			result.Info.PartialRemaining = len(fetchTargets) - result.Info.Scanned
		} else if capped {
			result.Info.PartialReason = fmt.Sprintf("server returned %d matches; fetched most recent %d", len(matched), fetchCandidatesCap)
			result.Info.PartialProcessed = len(fetchTargets)
			result.Info.PartialRemaining = len(matched) - len(fetchTargets)
		}
		return result, nil
	})
}

func matchesQueryGroups(haystack string, groups [][]string) bool {
	for _, group := range groups {
		all := true
		for _, term := range group {
			if !strings.Contains(haystack, strings.ToLower(term)) {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}
