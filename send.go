package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	gomail "github.com/wneessen/go-mail"
)

type attachmentInput struct {
	Path        string `json:"path" jsonschema:"Absolute path of the file to attach"`
	Filename    string `json:"filename,omitempty" jsonschema:"Filename to present to the recipient (defaults to the file's base name)"`
	ContentType string `json:"contentType,omitempty" jsonschema:"MIME type override"`
}

type outgoingMessage struct {
	To          []string
	Cc          []string
	Bcc         []string
	Subject     string
	Text        string
	HTML        string
	Attachments []attachmentInput
	InReplyTo   string
	References  []string
}

func sendMessage(ctx context.Context, cfg *config, out outgoingMessage) error {
	m := gomail.NewMsg()
	var err error
	if cfg.FromName != "" {
		err = m.FromFormat(cfg.FromName, cfg.From)
	} else {
		err = m.From(cfg.From)
	}
	if err != nil {
		return fmt.Errorf("invalid from address: %w", err)
	}
	if cfg.ReplyTo != "" {
		if err := m.ReplyTo(cfg.ReplyTo); err != nil {
			return fmt.Errorf("invalid reply-to address: %w", err)
		}
	}
	if err := m.To(out.To...); err != nil {
		return fmt.Errorf("invalid to address: %w", err)
	}
	if len(out.Cc) > 0 {
		if err := m.Cc(out.Cc...); err != nil {
			return fmt.Errorf("invalid cc address: %w", err)
		}
	}
	if len(out.Bcc) > 0 {
		if err := m.Bcc(out.Bcc...); err != nil {
			return fmt.Errorf("invalid bcc address: %w", err)
		}
	}
	m.Subject(out.Subject)

	switch {
	case out.Text != "" && out.HTML != "":
		m.SetBodyString(gomail.TypeTextPlain, out.Text)
		m.AddAlternativeString(gomail.TypeTextHTML, out.HTML)
	case out.HTML != "":
		m.SetBodyString(gomail.TypeTextHTML, out.HTML)
	default:
		m.SetBodyString(gomail.TypeTextPlain, out.Text)
	}

	if out.InReplyTo != "" {
		m.SetGenHeader(gomail.HeaderInReplyTo, out.InReplyTo)
	}
	if len(out.References) > 0 {
		refs := make([]string, 0, len(out.References))
		for _, r := range out.References {
			r = strings.Trim(strings.TrimSpace(r), "<>")
			if r != "" {
				refs = append(refs, "<"+r+">")
			}
		}
		m.SetGenHeader(gomail.HeaderReferences, strings.Join(refs, " "))
	}

	for _, att := range out.Attachments {
		var opts []gomail.FileOption
		if att.Filename != "" {
			opts = append(opts, gomail.WithFileName(att.Filename))
		}
		if att.ContentType != "" {
			opts = append(opts, gomail.WithFileContentType(gomail.ContentType(att.ContentType)))
		}
		m.AttachFile(att.Path, opts...)
	}

	clientOpts := []gomail.Option{
		gomail.WithPort(cfg.SMTP.Port),
		gomail.WithUsername(cfg.Username),
		gomail.WithPassword(cfg.AppPassword),
		gomail.WithSMTPAuth(gomail.SMTPAuthPlain),
		gomail.WithTimeout(30 * time.Second),
	}
	if cfg.SMTP.Secure {
		clientOpts = append(clientOpts, gomail.WithSSL())
	} else {
		clientOpts = append(clientOpts, gomail.WithTLSPolicy(gomail.TLSMandatory))
	}
	client, err := gomail.NewClient(cfg.SMTP.Host, clientOpts...)
	if err != nil {
		return fmt.Errorf("SMTP client setup failed: %w", err)
	}
	if err := client.DialAndSendWithContext(ctx, m); err != nil {
		return fmt.Errorf("SMTP send failed: %w", err)
	}
	return nil
}
