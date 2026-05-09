import { Type } from "@sinclair/typebox";
import { ImapFlow, type FetchMessageObject, type FetchQueryObject } from "imapflow";
import { simpleParser, type ParsedMail, type Attachment as ParsedAttachment } from "mailparser";
import nodemailer from "nodemailer";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
// @ts-ignore - resolved at runtime by the OpenClaw host
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_IMAP_HOST = "imap.gmail.com";
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_HOST = "smtp.gmail.com";
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_WINDOW = 100;
const BODY_TEXT_LIMIT = 4000;

interface RawConfig {
  username?: string;
  appPassword?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  imap?: { host?: string; port?: number; secure?: boolean };
  smtp?: { host?: string; port?: number; secure?: boolean };
  defaultMailbox?: string;
  defaultSearchLimit?: number;
  defaultSearchWindow?: number;
  attachmentsDir?: string;
  requireExplicitSendConfirmation?: boolean;
}

interface NormalizedConfig {
  username: string;
  appPassword: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  defaultMailbox: string;
  defaultSearchLimit: number;
  defaultSearchWindow: number;
  attachmentsDir: string;
  requireExplicitSendConfirmation: boolean;
}

function normalizeConfig(input: RawConfig): NormalizedConfig {
  if (!input.username || !input.username.includes("@")) {
    throw new Error("gmail plugin: 'username' is required and must be a full email address");
  }
  if (!input.appPassword) {
    throw new Error("gmail plugin: 'appPassword' is required");
  }
  return {
    username: input.username,
    appPassword: input.appPassword.replace(/\s+/g, ""),
    from: input.from ?? input.username,
    fromName: input.fromName,
    replyTo: input.replyTo,
    imap: {
      host: input.imap?.host ?? DEFAULT_IMAP_HOST,
      port: input.imap?.port ?? DEFAULT_IMAP_PORT,
      secure: input.imap?.secure ?? true,
    },
    smtp: {
      host: input.smtp?.host ?? DEFAULT_SMTP_HOST,
      port: input.smtp?.port ?? DEFAULT_SMTP_PORT,
      secure: input.smtp?.secure ?? true,
    },
    defaultMailbox: input.defaultMailbox ?? DEFAULT_MAILBOX,
    defaultSearchLimit: input.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT,
    defaultSearchWindow: input.defaultSearchWindow ?? DEFAULT_SEARCH_WINDOW,
    attachmentsDir: input.attachmentsDir ?? join(homedir(), ".openclaw", "inbox", "gmail"),
    requireExplicitSendConfirmation: input.requireExplicitSendConfirmation ?? true,
  };
}

function sanitizeFsName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "").replace(/[\/\\\0]/g, "_").replace(/^\.+/, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatAddress(addr: { name?: string; address?: string } | undefined): string {
  if (!addr) return "";
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address ?? addr.name ?? "";
}

function formatAddressList(list: { name?: string; address?: string }[] | undefined): string {
  if (!list || list.length === 0) return "";
  return list.map(formatAddress).filter(Boolean).join(", ");
}

function normalizeRecipients(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function lower(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = v.trim();
    if (!key) continue;
    const lk = key.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    out.push(key);
  }
  return out;
}

interface MessageSummary {
  mailbox: string;
  uid: number;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string | null;
  preview: string;
  flags: string[];
  unread: boolean;
  flagged: boolean;
  messageId: string | undefined;
}

interface AttachmentMeta {
  filename: string | undefined;
  contentType: string | undefined;
  size: number | undefined;
}

interface FullMessage extends MessageSummary {
  bodyText: string;
  html: string | undefined;
  attachments: AttachmentMeta[];
  replyTo: string;
  references: string[];
}

async function readSourceText(source: unknown): Promise<string> {
  if (!source) return "";
  if (typeof source === "string") return source;
  if (Buffer.isBuffer(source)) return source.toString("utf8");
  // imapflow may return a Readable
  const chunks: Buffer[] = [];
  for await (const chunk of source as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toSummary(mailbox: string, item: FetchMessageObject, bodyText: string): MessageSummary {
  const flags = Array.from(item.flags ?? []).map(String);
  const subject = item.envelope?.subject ?? "";
  const from = formatAddressList(item.envelope?.from);
  const to = formatAddressList(item.envelope?.to);
  const cc = formatAddressList(item.envelope?.cc);
  const previewSource = compactWhitespace(bodyText) || compactWhitespace(subject) || "";
  const messageId = Array.isArray(item.envelope?.messageId)
    ? item.envelope?.messageId[0]
    : item.envelope?.messageId;
  return {
    mailbox,
    uid: Number(item.uid),
    subject,
    from,
    to,
    cc,
    date: item.internalDate ? new Date(item.internalDate).toISOString() : null,
    preview: truncate(previewSource, 160),
    flags,
    unread: !flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    messageId,
  };
}

async function toFullMessage(mailbox: string, item: FetchMessageObject): Promise<FullMessage> {
  const parsed = await simpleParser(await readSourceText(item.source));
  const summary = toSummary(mailbox, item, parsed.text ?? "");
  const refs = parsed.references;
  const references = Array.isArray(refs) ? refs.map(String) : refs ? [String(refs)] : [];
  return {
    ...summary,
    bodyText: (parsed.text ?? "").trim(),
    html: typeof parsed.html === "string" ? parsed.html : undefined,
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? undefined,
      contentType: a.contentType,
      size: a.size,
    })),
    replyTo: parsed.replyTo?.text ?? "",
    references,
  };
}

async function withImapClient<T>(
  cfg: NormalizedConfig,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: { user: cfg.username, pass: cfg.appPassword },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // best-effort
    }
  }
}

async function withMailboxLock<T>(
  client: ImapFlow,
  mailbox: string,
  fn: () => Promise<T>
): Promise<T> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

async function fetchMessageByUid(client: ImapFlow, uid: number): Promise<FetchMessageObject> {
  const item = await client.fetchOne(
    String(uid),
    { uid: true, envelope: true, flags: true, internalDate: true, source: true },
    { uid: true }
  );
  if (!item) throw new Error(`Message uid ${uid} not found`);
  return item;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? undefined : d;
}

interface SearchParams {
  mailbox?: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  unread?: boolean;
  flagged?: boolean;
  since?: string;
  before?: string;
  limit?: number;
}

function filterSummary(summary: MessageSummary, p: SearchParams, bodyText: string): boolean {
  if (typeof p.unread === "boolean" && summary.unread !== p.unread) return false;
  if (typeof p.flagged === "boolean" && summary.flagged !== p.flagged) return false;
  if (p.from && !lower(summary.from).includes(lower(p.from))) return false;
  if (p.to && !lower(`${summary.to},${summary.cc}`).includes(lower(p.to))) return false;
  if (p.subject && !lower(summary.subject).includes(lower(p.subject))) return false;
  if (p.query) {
    const haystack = lower(`${summary.subject} ${summary.from} ${summary.to} ${summary.preview} ${bodyText}`);
    if (!haystack.includes(lower(p.query))) return false;
  }
  const date = parseDate(summary.date ?? undefined);
  if (p.since) {
    const since = parseDate(p.since);
    if (since && (!date || date.valueOf() < since.valueOf())) return false;
  }
  if (p.before) {
    const before = parseDate(p.before);
    if (before && (!date || date.valueOf() >= before.valueOf())) return false;
  }
  return true;
}

function createRuntime(cfg: NormalizedConfig) {
  return {
    async listMailboxes() {
      return withImapClient(cfg, async (client) => {
        const mailboxes = await client.list();
        return mailboxes.map((mb) => ({
          path: mb.path,
          name: mb.name,
          delimiter: mb.delimiter,
          flags: Array.from(mb.flags ?? []).map(String),
          specialUse: mb.specialUse,
        }));
      });
    },

    async searchMessages(params: SearchParams) {
      const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      const limit = Math.min(params.limit ?? cfg.defaultSearchLimit, 100);
      const scanWindow = Math.min(Math.max(cfg.defaultSearchWindow, limit), 500);
      const needsBody = Boolean(params.query);
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          const status = await client.status(mailbox, { messages: true });
          const totalMessages = Number(status.messages ?? 0);
          if (totalMessages === 0) return [];
          const start = Math.max(1, totalMessages - scanWindow + 1);
          const fetchQuery: FetchQueryObject = {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
          };
          if (needsBody) fetchQuery.source = true;
          const matches: MessageSummary[] = [];
          for await (const item of client.fetch(`${start}:*`, fetchQuery)) {
            const bodyText = needsBody && item.source
              ? (await simpleParser(await readSourceText(item.source))).text ?? ""
              : "";
            const summary = toSummary(mailbox, item, bodyText);
            if (!filterSummary(summary, params, bodyText)) continue;
            matches.push(summary);
          }
          return matches
            .sort((a, b) => {
              const da = parseDate(a.date ?? undefined)?.valueOf() ?? 0;
              const db = parseDate(b.date ?? undefined)?.valueOf() ?? 0;
              return db - da || b.uid - a.uid;
            })
            .slice(0, limit);
        })
      );
    },

    async getMessage(params: { mailbox?: string; uid: number }) {
      const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          const item = await fetchMessageByUid(client, params.uid);
          return toFullMessage(mailbox, item);
        })
      );
    },

    async downloadAttachments(params: { mailbox?: string; uid: number; filenames?: string[] }) {
      const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      const filterSet = params.filenames && params.filenames.length
        ? new Set(params.filenames.map(String))
        : null;
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          const item = await fetchMessageByUid(client, params.uid);
          const parsed: ParsedMail = await simpleParser(await readSourceText(item.source));
          const safeMailbox = sanitizeFsName(mailbox, "INBOX");
          const targetDir = join(cfg.attachmentsDir, `${safeMailbox}-${params.uid}`);
          await mkdir(targetDir, { recursive: true });
          const saved: { filename: string; path: string; contentType?: string; size: number }[] = [];
          const skipped: { filename: string; reason: string }[] = [];
          let i = 0;
          for (const att of (parsed.attachments ?? []) as ParsedAttachment[]) {
            i += 1;
            const filename = sanitizeFsName(att.filename, `attachment-${i}`);
            if (filterSet && att.filename && !filterSet.has(att.filename)) {
              skipped.push({ filename: att.filename, reason: "not in filenames filter" });
              continue;
            }
            if (!att.content || !Buffer.isBuffer(att.content)) {
              skipped.push({ filename, reason: "no buffer content" });
              continue;
            }
            const path = join(targetDir, filename);
            await writeFile(path, att.content);
            saved.push({
              filename,
              path,
              contentType: att.contentType,
              size: att.size ?? att.content.length,
            });
          }
          return { mailbox, uid: params.uid, directory: targetDir, saved, skipped };
        })
      );
    },

    async updateMessage(params: { mailbox?: string; uid: number; read?: boolean; flagged?: boolean }) {
      const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          if (typeof params.read === "boolean") {
            const op = params.read ? client.messageFlagsAdd : client.messageFlagsRemove;
            await op.call(client, String(params.uid), ["\\Seen"], { uid: true });
          }
          if (typeof params.flagged === "boolean") {
            const op = params.flagged ? client.messageFlagsAdd : client.messageFlagsRemove;
            await op.call(client, String(params.uid), ["\\Flagged"], { uid: true });
          }
          return { mailbox, uid: params.uid, read: params.read, flagged: params.flagged };
        })
      );
    },

    async moveMessage(params: { mailbox?: string; uid: number; destinationMailbox: string }) {
      const sourceMailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, sourceMailbox, async () => {
          await client.messageMove(String(params.uid), params.destinationMailbox, { uid: true });
          return { sourceMailbox, destinationMailbox: params.destinationMailbox, uid: params.uid };
        })
      );
    },

    async sendMessage(params: {
      to: string | string[];
      cc?: string | string[];
      bcc?: string | string[];
      subject: string;
      text?: string;
      html?: string;
      attachments?: { path: string; filename?: string; contentType?: string }[];
      inReplyTo?: string;
      references?: string[];
    }) {
      const transport = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth: { user: cfg.username, pass: cfg.appPassword },
      });
      try {
        const info = await transport.sendMail({
          from: cfg.fromName ? `${cfg.fromName} <${cfg.from}>` : cfg.from,
          replyTo: cfg.replyTo,
          to: normalizeRecipients(params.to),
          cc: normalizeRecipients(params.cc),
          bcc: normalizeRecipients(params.bcc),
          subject: params.subject,
          text: params.text,
          html: params.html,
          inReplyTo: params.inReplyTo,
          references: params.references,
          attachments: (params.attachments ?? []).map((a) => ({
            path: a.path,
            filename: a.filename,
            contentType: a.contentType,
          })),
        });
        return {
          accepted: (info.accepted ?? []).map(String),
          rejected: (info.rejected ?? []).map(String),
          response: info.response ?? "Message sent.",
          messageId: info.messageId,
          subject: params.subject,
          to: normalizeRecipients(params.to),
          cc: normalizeRecipients(params.cc),
          bcc: normalizeRecipients(params.bcc),
        };
      } finally {
        transport.close();
      }
    },
  };
}

function formatMailboxList(mailboxes: Array<{ path: string; name: string; specialUse?: string; flags: string[] }>): string {
  if (!mailboxes.length) return "(no mailboxes)";
  return mailboxes
    .map((mb) => `- ${mb.path}${mb.specialUse ? ` [${mb.specialUse}]` : ""}${mb.flags.length ? ` flags=${mb.flags.join(",")}` : ""}`)
    .join("\n");
}

function formatMessageList(messages: MessageSummary[]): string {
  if (!messages.length) return "(no messages)";
  return messages
    .map((m) => {
      const flags = [m.unread ? "unread" : "", m.flagged ? "flagged" : ""].filter(Boolean).join(",");
      return [
        `uid ${m.uid} [${m.mailbox}]${flags ? ` (${flags})` : ""}`,
        `  date: ${m.date ?? "?"}`,
        `  from: ${m.from}`,
        `  subject: ${m.subject}`,
        `  preview: ${m.preview}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatMessage(message: FullMessage): string {
  const lines = [
    `uid: ${message.uid}`,
    `mailbox: ${message.mailbox}`,
    `date: ${message.date ?? "?"}`,
    `from: ${message.from}`,
    `to: ${message.to}`,
  ];
  if (message.cc) lines.push(`cc: ${message.cc}`);
  if (message.replyTo) lines.push(`reply-to: ${message.replyTo}`);
  lines.push(`subject: ${message.subject}`);
  lines.push(`flags: ${message.flags.join(", ") || "(none)"}`);
  if (message.attachments.length) {
    lines.push(
      `attachments: ${message.attachments
        .map((a) => `${a.filename || a.contentType || "attachment"}${a.size ? ` (${a.size}B)` : ""}`)
        .join(", ")}`
    );
  } else {
    lines.push("attachments: (none)");
  }
  lines.push("", "body:", truncate(message.bodyText || "(no text body)", BODY_TEXT_LIMIT));
  return lines.join("\n");
}

function toolTextResult<T extends Record<string, unknown>>(text: string, details: T) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

const recipientSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
]);

const attachmentInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  filename: Type.Optional(Type.String({ minLength: 1 })),
  contentType: Type.Optional(Type.String({ minLength: 1 })),
});

export default definePluginEntry({
  id: "gmail",
  name: "Gmail",
  description: "Read, search, send, reply, organize, and download attachments over IMAP/SMTP using a Gmail App Password.",
  register(api: any) {
    const cfg = normalizeConfig((api.pluginConfig ?? {}) as RawConfig);
    const runtime = createRuntime(cfg);

    api.registerTool({
      name: "gmail_mailboxes_list",
      label: "List mailboxes",
      description: "List the mailboxes (folders/labels) on the configured account.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const mailboxes = await runtime.listMailboxes();
        return toolTextResult(formatMailboxList(mailboxes), {
          status: "ok",
          count: mailboxes.length,
          mailboxes,
        });
      },
    });

    api.registerTool({
      name: "gmail_messages_search",
      label: "Search messages",
      description: "Search recent messages by sender, recipient, subject, free text, flags, or date range.",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        query: Type.Optional(Type.String({ minLength: 1 })),
        from: Type.Optional(Type.String({ minLength: 1 })),
        to: Type.Optional(Type.String({ minLength: 1 })),
        subject: Type.Optional(Type.String({ minLength: 1 })),
        unread: Type.Optional(Type.Boolean()),
        flagged: Type.Optional(Type.Boolean()),
        since: Type.Optional(Type.String({ minLength: 1 })),
        before: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      async execute(_id: unknown, params: SearchParams) {
        const messages = await runtime.searchMessages(params);
        return toolTextResult(formatMessageList(messages), {
          status: "ok",
          count: messages.length,
          messages,
        });
      },
    });

    api.registerTool({
      name: "gmail_message_get",
      label: "Get message",
      description: "Fetch one message by UID with body and attachment metadata.",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        uid: Type.Integer({ minimum: 1 }),
      }),
      async execute(_id: unknown, params: { mailbox?: string; uid: number }) {
        const message = await runtime.getMessage(params);
        return toolTextResult(formatMessage(message), { status: "ok", message });
      },
    });

    api.registerTool({
      name: "gmail_message_attachments_save",
      label: "Save attachments",
      description: "Download all (or filtered) attachments of one message to the configured attachments directory.",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        uid: Type.Integer({ minimum: 1 }),
        filenames: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      }),
      async execute(_id: unknown, params: { mailbox?: string; uid: number; filenames?: string[] }) {
        const result = await runtime.downloadAttachments(params);
        const lines = [
          `mailbox: ${result.mailbox}`,
          `uid: ${result.uid}`,
          `directory: ${result.directory}`,
          `saved: ${result.saved.length}`,
          ...result.saved.map((a) => `  - ${a.filename} (${a.contentType ?? "?"}, ${a.size}B) -> ${a.path}`),
        ];
        if (result.skipped.length) {
          lines.push(`skipped: ${result.skipped.length}`);
          for (const s of result.skipped) lines.push(`  - ${s.filename}: ${s.reason}`);
        }
        return toolTextResult(lines.join("\n"), {
          status: result.saved.length > 0 ? "ok" : "empty",
          ...result,
        });
      },
    });

    api.registerTool({
      name: "gmail_message_update",
      label: "Update flags",
      description: "Mark one message as read/unread and/or set/clear its starred state.",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        uid: Type.Integer({ minimum: 1 }),
        read: Type.Optional(Type.Boolean()),
        flagged: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: unknown, params: { mailbox?: string; uid: number; read?: boolean; flagged?: boolean }) {
        if (typeof params.read !== "boolean" && typeof params.flagged !== "boolean") {
          throw new Error("Provide at least one flag update: read and/or flagged.");
        }
        const result = await runtime.updateMessage(params);
        return toolTextResult(
          `Updated ${result.mailbox} uid ${result.uid}${typeof result.read === "boolean" ? ` read=${result.read}` : ""}${typeof result.flagged === "boolean" ? ` flagged=${result.flagged}` : ""}`,
          { status: "updated", ...result }
        );
      },
    });

    api.registerTool({
      name: "gmail_message_move",
      label: "Move message",
      description: "Move one message from the selected mailbox to another mailbox.",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        uid: Type.Integer({ minimum: 1 }),
        destinationMailbox: Type.String({ minLength: 1 }),
      }),
      async execute(_id: unknown, params: { mailbox?: string; uid: number; destinationMailbox: string }) {
        const result = await runtime.moveMessage(params);
        return toolTextResult(
          `Moved uid ${result.uid} from ${result.sourceMailbox} to ${result.destinationMailbox}`,
          { status: "moved", ...result }
        );
      },
    });

    api.registerTool({
      name: "gmail_message_send",
      label: "Send message",
      description: "Send a new email. With requireExplicitSendConfirmation=true, must pass confirm=true.",
      parameters: Type.Object({
        to: recipientSchema,
        cc: Type.Optional(recipientSchema),
        bcc: Type.Optional(recipientSchema),
        subject: Type.String({ minLength: 1 }),
        text: Type.Optional(Type.String()),
        html: Type.Optional(Type.String()),
        attachments: Type.Optional(Type.Array(attachmentInputSchema)),
        confirm: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: unknown, params: any) {
        if (cfg.requireExplicitSendConfirmation && params.confirm !== true) {
          return toolTextResult(
            "Refusing to send: requireExplicitSendConfirmation is enabled and confirm=true was not provided.",
            { status: "refused", reason: "missing_confirmation" }
          );
        }
        if (!params.text && !params.html) {
          throw new Error("Provide text and/or html body");
        }
        const result = await runtime.sendMessage(params);
        return toolTextResult(
          `Sent. accepted=[${result.accepted.join(", ")}] rejected=[${result.rejected.join(", ")}] subject="${result.subject}"`,
          { status: "sent", ...result }
        );
      },
    });

    api.registerTool({
      name: "gmail_message_reply",
      label: "Reply to message",
      description: "Reply to an existing message by UID. replyAll=true CCs all original recipients (excluding self).",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        uid: Type.Integer({ minimum: 1 }),
        text: Type.Optional(Type.String()),
        html: Type.Optional(Type.String()),
        replyAll: Type.Optional(Type.Boolean()),
        attachments: Type.Optional(Type.Array(attachmentInputSchema)),
        confirm: Type.Optional(Type.Boolean()),
      }),
      async execute(_id: unknown, params: any) {
        if (cfg.requireExplicitSendConfirmation && params.confirm !== true) {
          return toolTextResult(
            "Refusing to reply: requireExplicitSendConfirmation is enabled and confirm=true was not provided.",
            { status: "refused", reason: "missing_confirmation" }
          );
        }
        if (!params.text && !params.html) {
          throw new Error("Provide text and/or html body");
        }
        const original = await runtime.getMessage(params);
        const ownAddresses = uniqueStrings([lower(cfg.from), lower(cfg.username)]);
        const replyTarget = original.replyTo || original.from;
        const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
        const messageIdRef = original.messageId ? `<${String(original.messageId).replace(/^<|>$/g, "")}>` : undefined;
        const references = uniqueStrings([...(original.references ?? []), messageIdRef ?? ""].filter(Boolean));
        let to: string[];
        let cc: string[] = [];
        if (params.replyAll) {
          const all = uniqueStrings(
            [replyTarget, original.to, original.cc]
              .join(",")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          ).filter((addr) => !ownAddresses.includes(lower(addr)));
          to = all.slice(0, 1);
          cc = all.slice(1);
        } else {
          to = [replyTarget].filter(Boolean);
        }
        const quoted = original.bodyText
          ? `\n\nOn ${original.date ?? ""}, ${original.from} wrote:\n${original.bodyText
              .split("\n")
              .map((l) => `> ${l}`)
              .join("\n")}`
          : "";
        const result = await runtime.sendMessage({
          to,
          cc,
          subject,
          text: params.text ? `${params.text}${quoted}` : undefined,
          html: params.html,
          inReplyTo: messageIdRef,
          references,
          attachments: params.attachments,
        });
        return toolTextResult(
          `Replied. accepted=[${result.accepted.join(", ")}] subject="${result.subject}"`,
          { status: "sent", ...result }
        );
      },
    });
  },
});
