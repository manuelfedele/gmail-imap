package main

import (
	"reflect"
	"testing"
)

func TestExtractOperators(t *testing.T) {
	remaining, parsed, picked := extractOperators(`invoice from:billing@example.com is:unread after:2026/01/02 has:attachment`)
	if remaining != "invoice" {
		t.Errorf("remaining = %q, want %q", remaining, "invoice")
	}
	if parsed.From != "billing@example.com" {
		t.Errorf("from = %q", parsed.From)
	}
	if parsed.Unread == nil || !*parsed.Unread {
		t.Error("unread not extracted")
	}
	if parsed.Since != "2026-01-02" {
		t.Errorf("since = %q, want 2026-01-02", parsed.Since)
	}
	if parsed.HasAttachment == nil || !*parsed.HasAttachment {
		t.Error("has:attachment not extracted")
	}
	if len(picked) != 4 {
		t.Errorf("picked = %v", picked)
	}
}

func TestExtractOperatorsQuoted(t *testing.T) {
	remaining, parsed, _ := extractOperators(`subject:"hello world" rest`)
	if parsed.Subject != "hello world" {
		t.Errorf("subject = %q", parsed.Subject)
	}
	if remaining != "rest" {
		t.Errorf("remaining = %q", remaining)
	}
}

func TestParseQueryGroups(t *testing.T) {
	groups := parseQueryGroups("alpha beta OR gamma")
	want := [][]string{{"alpha", "beta"}, {"gamma"}}
	if !reflect.DeepEqual(groups, want) {
		t.Errorf("groups = %v, want %v", groups, want)
	}
	if matchesQueryGroups("contains gamma here", groups) != true {
		t.Error("expected OR group to match")
	}
	if matchesQueryGroups("contains alpha only", groups) != false {
		t.Error("expected AND group not to match")
	}
}

func TestHTMLToText(t *testing.T) {
	got := htmlToText(`<style>p{color:red}</style><p>Hello &amp; goodbye</p><br><script>x()</script><div>Second</div>`)
	want := "Hello & goodbye\n\nSecond"
	if got != want {
		t.Errorf("htmlToText = %q, want %q", got, want)
	}
}

func TestSanitizeFsName(t *testing.T) {
	if got := sanitizeFsName("../../etc/passwd", "fb"); got == "" || got[0] == '.' {
		t.Errorf("sanitizeFsName traversal = %q", got)
	}
	if got := sanitizeFsName("", "fallback"); got != "fallback" {
		t.Errorf("fallback = %q", got)
	}
}

func TestNormalizeConfigDefaults(t *testing.T) {
	cfg, err := normalizeConfig(rawConfig{Username: "a@b.c", AppPassword: "xx yy"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AppPassword != "xxyy" {
		t.Errorf("app password spaces not stripped: %q", cfg.AppPassword)
	}
	if cfg.From != "a@b.c" || cfg.IMAP.Host != defaultIMAPHost || cfg.SMTP.Port != defaultSMTPPort {
		t.Errorf("defaults not applied: %+v", cfg)
	}
	if !cfg.RequireExplicitSendConfirmation {
		t.Error("send confirmation should default to true")
	}
	if _, err := normalizeConfig(rawConfig{Username: "nodomain"}); err == nil {
		t.Error("expected error for invalid config")
	}
}

func TestResolveSearchParamsDefaultSince(t *testing.T) {
	effective, _ := resolveSearchParams(searchParams{Query: "hello"})
	if effective.Since == "" {
		t.Error("expected default since to be applied")
	}
	effective, _ = resolveSearchParams(searchParams{Before: "2026-01-01"})
	if effective.Since != "" {
		t.Error("default since must not be applied when before is set")
	}
}

func TestUniqueStrings(t *testing.T) {
	got := uniqueStrings([]string{"A@b.c", "a@B.C", "", "d@e.f"})
	if !reflect.DeepEqual(got, []string{"A@b.c", "d@e.f"}) {
		t.Errorf("uniqueStrings = %v", got)
	}
}
