package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	defaultIMAPHost    = "imap.gmail.com"
	defaultIMAPPort    = 993
	defaultSMTPHost    = "smtp.gmail.com"
	defaultSMTPPort    = 465
	defaultMailbox     = "INBOX"
	defaultSearchLimit = 10
)

type endpointConfig struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Secure *bool  `json:"secure"`
}

type rawConfig struct {
	Username                        string         `json:"username"`
	AppPassword                     string         `json:"appPassword"`
	From                            string         `json:"from"`
	FromName                        string         `json:"fromName"`
	ReplyTo                         string         `json:"replyTo"`
	IMAP                            endpointConfig `json:"imap"`
	SMTP                            endpointConfig `json:"smtp"`
	DefaultMailbox                  string         `json:"defaultMailbox"`
	DefaultSearchLimit              int            `json:"defaultSearchLimit"`
	AttachmentsDir                  string         `json:"attachmentsDir"`
	RequireExplicitSendConfirmation *bool          `json:"requireExplicitSendConfirmation"`
}

type endpoint struct {
	Host   string
	Port   int
	Secure bool
}

type config struct {
	Username                        string
	AppPassword                     string
	From                            string
	FromName                        string
	ReplyTo                         string
	IMAP                            endpoint
	SMTP                            endpoint
	DefaultMailbox                  string
	DefaultSearchLimit              int
	AttachmentsDir                  string
	RequireExplicitSendConfirmation bool
}

func configPath() string {
	if p := strings.TrimSpace(os.Getenv("GMAIL_IMAP_CONFIG")); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".gmail-imap", "config.json")
}

func configHelp() string {
	return strings.Join([]string{
		"gmail-imap is not configured. Provide credentials one of two ways:",
		"",
		fmt.Sprintf("1. Config file at %s (recommended):", configPath()),
		`   { "username": "you@gmail.com", "appPassword": "xxxxxxxxxxxxxxxx", "fromName": "Your Name" }`,
		"",
		"2. Environment variables: GMAIL_USERNAME, GMAIL_APP_PASSWORD (plus optional GMAIL_FROM,",
		"   GMAIL_FROM_NAME, GMAIL_REPLY_TO, GMAIL_IMAP_HOST/PORT, GMAIL_SMTP_HOST/PORT,",
		"   GMAIL_DEFAULT_MAILBOX, GMAIL_ATTACHMENTS_DIR).",
		"",
		"Generate a Gmail App Password at https://myaccount.google.com/apppasswords (requires 2FA).",
	}, "\n")
}

// Treat empty strings as unset so blank env expansions don't shadow the config file.
func envStr(name string) (string, bool) {
	v := os.Getenv(name)
	if strings.TrimSpace(v) == "" {
		return "", false
	}
	return v, true
}

var falseRe = regexp.MustCompile(`(?i)^(?:0|false|no|off)$`)

func envBool(name string) (bool, bool) {
	v, ok := envStr(name)
	if !ok {
		return false, false
	}
	return !falseRe.MatchString(v), true
}

func envInt(name string) (int, bool) {
	v, ok := envStr(name)
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, false
	}
	return n, true
}

// loadConfig merges the config file (if present) with environment variables. Env wins.
func loadConfig() (*config, error) {
	raw := rawConfig{}
	path := configPath()
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &raw); err != nil {
			return nil, fmt.Errorf("gmail-imap: failed to parse config at %s: %w", path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("gmail-imap: failed to read config at %s: %w", path, err)
	}

	if v, ok := envStr("GMAIL_USERNAME"); ok {
		raw.Username = v
	}
	if v, ok := envStr("GMAIL_APP_PASSWORD"); ok {
		raw.AppPassword = v
	}
	if v, ok := envStr("GMAIL_FROM"); ok {
		raw.From = v
	}
	if v, ok := envStr("GMAIL_FROM_NAME"); ok {
		raw.FromName = v
	}
	if v, ok := envStr("GMAIL_REPLY_TO"); ok {
		raw.ReplyTo = v
	}
	if v, ok := envStr("GMAIL_IMAP_HOST"); ok {
		raw.IMAP.Host = v
	}
	if v, ok := envInt("GMAIL_IMAP_PORT"); ok {
		raw.IMAP.Port = v
	}
	if v, ok := envBool("GMAIL_IMAP_SECURE"); ok {
		raw.IMAP.Secure = &v
	}
	if v, ok := envStr("GMAIL_SMTP_HOST"); ok {
		raw.SMTP.Host = v
	}
	if v, ok := envInt("GMAIL_SMTP_PORT"); ok {
		raw.SMTP.Port = v
	}
	if v, ok := envBool("GMAIL_SMTP_SECURE"); ok {
		raw.SMTP.Secure = &v
	}
	if v, ok := envStr("GMAIL_DEFAULT_MAILBOX"); ok {
		raw.DefaultMailbox = v
	}
	if v, ok := envInt("GMAIL_DEFAULT_SEARCH_LIMIT"); ok {
		raw.DefaultSearchLimit = v
	}
	if v, ok := envStr("GMAIL_ATTACHMENTS_DIR"); ok {
		raw.AttachmentsDir = v
	}
	if v, ok := envBool("GMAIL_REQUIRE_SEND_CONFIRMATION"); ok {
		raw.RequireExplicitSendConfirmation = &v
	}

	return normalizeConfig(raw)
}

var whitespaceRe = regexp.MustCompile(`\s+`)

func normalizeConfig(raw rawConfig) (*config, error) {
	if raw.Username == "" || !strings.Contains(raw.Username, "@") || raw.AppPassword == "" {
		return nil, errors.New(configHelp())
	}
	cfg := &config{
		Username:                        raw.Username,
		AppPassword:                     whitespaceRe.ReplaceAllString(raw.AppPassword, ""),
		From:                            raw.From,
		FromName:                        raw.FromName,
		ReplyTo:                         raw.ReplyTo,
		IMAP:                            endpoint{Host: defaultIMAPHost, Port: defaultIMAPPort, Secure: true},
		SMTP:                            endpoint{Host: defaultSMTPHost, Port: defaultSMTPPort, Secure: true},
		DefaultMailbox:                  defaultMailbox,
		DefaultSearchLimit:              defaultSearchLimit,
		AttachmentsDir:                  raw.AttachmentsDir,
		RequireExplicitSendConfirmation: true,
	}
	if cfg.From == "" {
		cfg.From = raw.Username
	}
	if raw.IMAP.Host != "" {
		cfg.IMAP.Host = raw.IMAP.Host
	}
	if raw.IMAP.Port != 0 {
		cfg.IMAP.Port = raw.IMAP.Port
	}
	if raw.IMAP.Secure != nil {
		cfg.IMAP.Secure = *raw.IMAP.Secure
	}
	if raw.SMTP.Host != "" {
		cfg.SMTP.Host = raw.SMTP.Host
	}
	if raw.SMTP.Port != 0 {
		cfg.SMTP.Port = raw.SMTP.Port
	}
	if raw.SMTP.Secure != nil {
		cfg.SMTP.Secure = *raw.SMTP.Secure
	}
	if raw.DefaultMailbox != "" {
		cfg.DefaultMailbox = raw.DefaultMailbox
	}
	if raw.DefaultSearchLimit > 0 {
		cfg.DefaultSearchLimit = raw.DefaultSearchLimit
	}
	if cfg.AttachmentsDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "."
		}
		cfg.AttachmentsDir = filepath.Join(home, ".gmail-imap", "attachments")
	}
	if raw.RequireExplicitSendConfirmation != nil {
		cfg.RequireExplicitSendConfirmation = *raw.RequireExplicitSendConfirmation
	}
	return cfg, nil
}
