import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapFlow, type FetchMessageObject, type FetchQueryObject } from "imapflow";
import { simpleParser, type ParsedMail, type Attachment as ParsedAttachment } from "mailparser";
import nodemailer from "nodemailer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_IMAP_HOST = "imap.gmail.com";
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_HOST = "smtp.gmail.com";
const DEFAULT_SMTP_PORT = 465;
const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SINCE_DAYS = 30;
const BODY_TEXT_LIMIT = 4000;
const FETCH_CANDIDATES_CAP = 1000;
const SEARCH_FETCH_TIMEOUT_MS = 30_000;
const IMAP_CONNECT_TIMEOUT_MS = 10_000;
const IMAP_RETRY_ATTEMPTS = 3;
const IMAP_RETRY_DELAYS_MS = [100, 500, 2000] as const;

// ─── Config ───────────────────────────────────────────────────────────────────

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
  attachmentsDir: string;
  requireExplicitSendConfirmation: boolean;
}

const CONFIG_PATH = process.env.GMAIL_IMAP_CONFIG ?? join(homedir(), ".gmail-imap", "config.json");

const CONFIG_HELP = [
  "gmail-imap is not configured. Provide credentials one of two ways:",
  "",
  `1. Config file at ${CONFIG_PATH} (recommended):`,
  '   { "username": "you@gmail.com", "appPassword": "xxxxxxxxxxxxxxxx", "fromName": "Your Name" }',
  "",
  "2. Environment variables: GMAIL_USERNAME, GMAIL_APP_PASSWORD (plus optional GMAIL_FROM,",
  "   GMAIL_FROM_NAME, GMAIL_REPLY_TO, GMAIL_IMAP_HOST/PORT, GMAIL_SMTP_HOST/PORT,",
  "   GMAIL_DEFAULT_MAILBOX, GMAIL_ATTACHMENTS_DIR).",
  "",
  "Generate a Gmail App Password at https://myaccount.google.com/apppasswords (requires 2FA).",
].join("\n");

/** Treat empty strings as unset so blank `${VAR}` expansions don't shadow the config file. */
function envStr(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return !/^(?:0|false|no|off)$/i.test(value);
}

function envInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Merge config file (if present) with environment variables. Env wins. */
async function loadRawConfig(): Promise<RawConfig> {
  let fileConfig: RawConfig = {};
  try {
    fileConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as RawConfig;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      throw new Error(`gmail-imap: failed to read config at ${CONFIG_PATH}: ${err?.message ?? err}`);
    }
  }
  const env = process.env;
  return {
    ...fileConfig,
    username: envStr(env.GMAIL_USERNAME) ?? fileConfig.username,
    appPassword: envStr(env.GMAIL_APP_PASSWORD) ?? fileConfig.appPassword,
    from: envStr(env.GMAIL_FROM) ?? fileConfig.from,
    fromName: envStr(env.GMAIL_FROM_NAME) ?? fileConfig.fromName,
    replyTo: envStr(env.GMAIL_REPLY_TO) ?? fileConfig.replyTo,
    imap: {
      host: envStr(env.GMAIL_IMAP_HOST) ?? fileConfig.imap?.host,
      port: envInt(env.GMAIL_IMAP_PORT) ?? fileConfig.imap?.port,
      secure: envBool(env.GMAIL_IMAP_SECURE) ?? fileConfig.imap?.secure,
    },
    smtp: {
      host: envStr(env.GMAIL_SMTP_HOST) ?? fileConfig.smtp?.host,
      port: envInt(env.GMAIL_SMTP_PORT) ?? fileConfig.smtp?.port,
      secure: envBool(env.GMAIL_SMTP_SECURE) ?? fileConfig.smtp?.secure,
    },
    defaultMailbox: envStr(env.GMAIL_DEFAULT_MAILBOX) ?? fileConfig.defaultMailbox,
    defaultSearchLimit: envInt(env.GMAIL_DEFAULT_SEARCH_LIMIT) ?? fileConfig.defaultSearchLimit,
    attachmentsDir: envStr(env.GMAIL_ATTACHMENTS_DIR) ?? fileConfig.attachmentsDir,
    requireExplicitSendConfirmation:
      envBool(env.GMAIL_REQUIRE_SEND_CONFIRMATION) ?? fileConfig.requireExplicitSendConfirmation,
  };
}

function normalizeConfig(input: RawConfig): NormalizedConfig {
  if (!input.username || !input.username.includes("@")) {
    throw new Error(CONFIG_HELP);
  }
  if (!input.appPassword) {
    throw new Error(CONFIG_HELP);
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
    attachmentsDir: input.attachmentsDir ?? join(homedir(), ".gmail-imap", "attachments"),
    requireExplicitSendConfirmation: input.requireExplicitSendConfirmation ?? true,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

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

function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(?:p|div|li|tr|h[1-6])[^>]*>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function lower(s: string): string {
  return s.toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? undefined : d;
}

function isGmailHost(host: string): boolean {
  return /(?:^|\.)gmail\.com$/i.test(host) || /(?:^|\.)googlemail\.com$/i.test(host);
}

// ─── IMAP helpers ─────────────────────────────────────────────────────────────

/** Build a compact IMAP UID sequence set, e.g. [1,2,3,7,8] → "1:3,7:8". */
function buildImapSequenceSet(uids: number[]): string {
  if (!uids.length) return "";
  const sorted = [...uids].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? String(start) : `${start}:${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}:${end}`);
  return ranges.join(",");
}

async function withImapClient<T>(cfg: NormalizedConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < IMAP_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, IMAP_RETRY_DELAYS_MS[attempt - 1]));
    }
    const client = new ImapFlow({
      host: cfg.imap.host,
      port: cfg.imap.port,
      secure: cfg.imap.secure,
      auth: { user: cfg.username, pass: cfg.appPassword },
      logger: false,
    });
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`IMAP connect timed out after ${IMAP_CONNECT_TIMEOUT_MS}ms`)),
            IMAP_CONNECT_TIMEOUT_MS
          )
        ),
      ]);
      try {
        return await fn(client);
      } finally {
        try { await client.logout(); } catch { /* best-effort */ }
      }
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = /connection not available|connect timed out|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|socket|network/i.test(msg);
      if (!isRetryable || attempt === IMAP_RETRY_ATTEMPTS - 1) throw err;
      try { client.close(); } catch { /* ignore */ }
    }
  }
  throw lastErr;
}

async function withMailboxLock<T>(client: ImapFlow, mailbox: string, fn: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(mailbox);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ─── Gmail IMAP extension helpers ─────────────────────────────────────────────
// imapflow has no typings for Gmail extensions (X-GM-EXT-1).
// All `as any` access is isolated here so business logic stays type-safe.

function getImapCapabilities(client: ImapFlow): string[] {
  try {
    const caps: unknown = (client as any).serverInfo?.capability;
    return Array.isArray(caps) ? caps.map(String) : [];
  } catch {
    return [];
  }
}

function clientHasGmailExt(client: ImapFlow): boolean {
  return getImapCapabilities(client).some((c) => /X-GM-EXT-1/i.test(c));
}

function getGmailThreadId(item: FetchMessageObject): string | undefined {
  const tid = (item as any).threadId;
  return tid != null ? String(tid) : undefined;
}

/** Build a FetchQueryObject, including optional Gmail/non-standard extensions. */
function buildFetchQuery(
  base: FetchQueryObject,
  extensions: { bodyStructure?: boolean; threadId?: boolean } = {}
): FetchQueryObject {
  const q: any = { ...base };
  if (extensions.bodyStructure) q.bodyStructure = true;
  if (extensions.threadId) q.threadId = true;
  return q as FetchQueryObject;
}

// ─── Data model ───────────────────────────────────────────────────────────────

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
  hasAttachments: boolean;
  messageId: string | undefined;
  threadId?: string;
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
  bodySource: "text" | "html-fallback" | "none";
}

async function readSourceText(source: unknown): Promise<string> {
  if (!source) return "";
  if (Buffer.isBuffer(source)) return source.toString("utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of source as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toSummary(
  mailbox: string,
  item: FetchMessageObject,
  bodyText: string,
  attachmentCount: number | undefined
): MessageSummary {
  const flags = Array.from(item.flags ?? []).map(String);
  return {
    mailbox,
    uid: Number(item.uid),
    subject: item.envelope?.subject ?? "",
    from: formatAddressList(item.envelope?.from),
    to: formatAddressList(item.envelope?.to),
    cc: formatAddressList(item.envelope?.cc),
    date: item.internalDate ? new Date(item.internalDate).toISOString() : null,
    preview: truncate(compactWhitespace(bodyText) || compactWhitespace(item.envelope?.subject ?? "") || "", 200),
    flags,
    unread: !flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    hasAttachments: typeof attachmentCount === "number" ? attachmentCount > 0 : false,
    messageId: Array.isArray(item.envelope?.messageId) ? item.envelope?.messageId[0] : item.envelope?.messageId,
    threadId: getGmailThreadId(item),
  };
}

async function toFullMessage(mailbox: string, item: FetchMessageObject): Promise<FullMessage> {
  const parsed = await simpleParser(await readSourceText(item.source));
  const textBody = (parsed.text ?? "").trim();
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  let bodyText = textBody;
  let bodySource: FullMessage["bodySource"] = textBody ? "text" : "none";
  if (!bodyText && html) {
    bodyText = htmlToText(html);
    if (bodyText) bodySource = "html-fallback";
  }
  const attachments = parsed.attachments ?? [];
  const summary = toSummary(mailbox, item, bodyText, attachments.length);
  const refs = parsed.references;
  return {
    ...summary,
    bodyText,
    html,
    attachments: attachments.map((a) => ({ filename: a.filename ?? undefined, contentType: a.contentType, size: a.size })),
    replyTo: parsed.replyTo?.text ?? "",
    references: Array.isArray(refs) ? refs.map(String) : refs ? [String(refs)] : [],
    bodySource,
  };
}

// ─── Search ───────────────────────────────────────────────────────────────────

function normalizeGmailDate(v: string): string {
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return v;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v)) return v.replace(/\//g, "-");
  return v;
}

function extractGmailOperators(query: string): {
  remaining: string;
  parsed: Pick<SearchParams, "from" | "to" | "subject" | "unread" | "flagged" | "hasAttachment" | "since" | "before" | "mailbox">;
  picked: string[];
} {
  const parsed: any = {};
  const picked: string[] = [];
  const opRe = /(\w+):(?:"([^"]+)"|(\S+))/g;
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = opRe.exec(query)) !== null) {
    const key = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : m[3];
    let consumed = false;
    switch (key) {
      case "from":    if (parsed.from === undefined)    { parsed.from = value; consumed = true; } break;
      case "to":      if (parsed.to === undefined)      { parsed.to = value; consumed = true; } break;
      case "subject": if (parsed.subject === undefined) { parsed.subject = value; consumed = true; } break;
      case "has":     if (/attachment/i.test(value))    { parsed.hasAttachment = true; consumed = true; } break;
      case "is":
        if (/^unread$/i.test(value))            { parsed.unread = true; consumed = true; }
        else if (/^read$/i.test(value))         { parsed.unread = false; consumed = true; }
        else if (/^(?:flagged|starred)$/i.test(value)) { parsed.flagged = true; consumed = true; }
        break;
      case "in":
      case "label":  if (parsed.mailbox === undefined) { parsed.mailbox = value; consumed = true; } break;
      case "before": if (parsed.before === undefined)  { parsed.before = normalizeGmailDate(value); consumed = true; } break;
      case "after":
      case "since":  if (parsed.since === undefined)   { parsed.since = normalizeGmailDate(value); consumed = true; } break;
    }
    if (consumed) {
      ranges.push([m.index, m.index + m[0].length]);
      picked.push(`${key}:${value}`);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let remaining = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) remaining += query.slice(cursor, start);
    cursor = end;
  }
  if (cursor < query.length) remaining += query.slice(cursor);
  return { remaining: remaining.replace(/\s+/g, " ").trim(), parsed, picked };
}

function parseQueryGroups(query: string | undefined): string[][] {
  if (!query?.trim()) return [];
  return query
    .trim()
    .split(/\s+OR\s+/i)
    .map((g) => g.split(/\s+/).filter((t) => t && !/^(?:AND|OR)$/i.test(t)))
    .filter((g) => g.length > 0);
}

/** Walk an imapflow bodyStructure tree and return true if any part is an attachment. */
function bsHasAttachment(bs: any): boolean {
  if (!bs) return false;
  if (String(bs.disposition || "").toLowerCase() === "attachment") return true;
  const filename =
    bs.dispositionParameters?.filename ??
    bs.dispositionParameters?.name ??
    bs.parameters?.name ??
    bs.parameters?.filename;
  const type = String(bs.type || "").toLowerCase();
  if (filename && type !== "multipart" && !type.startsWith("text/")) return true;
  if (Array.isArray(bs.childNodes) && bs.childNodes.some(bsHasAttachment)) return true;
  return false;
}

interface SearchParams {
  mailbox?: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  unread?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  since?: string;
  before?: string;
  limit?: number;
  gmailRaw?: string;
}

interface SearchInfo {
  serverSearchUsed: boolean;
  matchedTotal: number;
  scanned: number;
  filteredClientSide: number;
  gmailRawUsed?: boolean;
  fetchMode: "envelope" | "bodyStructure" | "source";
  effectiveSince?: string;
  partial?: { reason: string; processed: number; remaining: number };
  pickedOperators?: string[];
  effectiveQuery?: string;
}

interface SearchResultBundle {
  messages: MessageSummary[];
  info: SearchInfo;
}

function resolveSearchParams(params: SearchParams): { effective: SearchParams; pickedOperators: string[] } {
  let effective = params;
  let pickedOperators: string[] = [];

  if (params.query && !params.gmailRaw) {
    const { remaining, parsed, picked } = extractGmailOperators(params.query);
    if (picked.length > 0) {
      pickedOperators = picked;
      effective = {
        ...params,
        from: params.from ?? parsed.from,
        to: params.to ?? parsed.to,
        subject: params.subject ?? parsed.subject,
        unread: params.unread ?? parsed.unread,
        flagged: params.flagged ?? parsed.flagged,
        hasAttachment: params.hasAttachment ?? parsed.hasAttachment,
        since: params.since ?? parsed.since,
        before: params.before ?? parsed.before,
        mailbox: params.mailbox ?? parsed.mailbox,
        query: remaining || undefined,
      };
    }
  }

  // Default to last DEFAULT_SINCE_DAYS when no temporal filter — prevents full-mailbox scans.
  if (!effective.since && !effective.before && !effective.gmailRaw) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DEFAULT_SINCE_DAYS);
    effective = { ...effective, since: cutoff.toISOString() };
  }

  return { effective, pickedOperators };
}

function buildServerCriteria(
  params: SearchParams,
  client: ImapFlow,
  cfg: NormalizedConfig
): { criteria: any; gmailRawUsed: boolean } {
  if (params.gmailRaw) {
    if (!isGmailHost(cfg.imap.host) || !clientHasGmailExt(client)) {
      throw new Error("gmailRaw was provided but the connected server does not advertise X-GM-EXT-1.");
    }
    return { criteria: { gmailRaw: params.gmailRaw }, gmailRawUsed: true };
  }
  const criteria: any = {};
  if (params.from) criteria.from = params.from;
  if (params.to) criteria.to = params.to;
  if (params.subject) criteria.subject = params.subject;
  if (params.unread === true) criteria.unseen = true;
  if (params.unread === false) criteria.seen = true;
  if (params.flagged === true) criteria.flagged = true;
  if (params.flagged === false) criteria.unflagged = true;
  const sinceDate = parseDate(params.since);
  if (sinceDate) criteria.since = sinceDate;
  const beforeDate = parseDate(params.before);
  if (beforeDate) criteria.before = beforeDate;
  return { criteria, gmailRawUsed: false };
}

function chooseFetchMode(
  queryGroups: string[][],
  hasAttachmentFilter: boolean
): "envelope" | "bodyStructure" | "source" {
  if (queryGroups.length > 0) return "source";      // need body text for client-side matching
  if (hasAttachmentFilter) return "bodyStructure";   // attachment detection without full source
  return "envelope";
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

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

    async searchMessages(params: SearchParams): Promise<SearchResultBundle> {
      const { effective, pickedOperators } = resolveSearchParams(params);
      const mailbox = effective.mailbox?.trim() || cfg.defaultMailbox;
      const limit = Math.min(effective.limit ?? cfg.defaultSearchLimit, 100);
      const queryGroups = parseQueryGroups(effective.query);
      const fetchMode = chooseFetchMode(queryGroups, effective.hasAttachment !== undefined);

      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          const { criteria, gmailRawUsed } = buildServerCriteria(effective, client, cfg);
          const matchedRaw = (await client.search(criteria, { uid: true })) ?? [];
          const matchedUids: number[] = (Array.isArray(matchedRaw) ? matchedRaw : []).map(Number);

          const baseInfo = {
            serverSearchUsed: true,
            matchedTotal: matchedUids.length,
            gmailRawUsed,
            fetchMode,
            effectiveSince: effective.since,
            pickedOperators: pickedOperators.length ? pickedOperators : undefined,
            effectiveQuery: effective.query,
          };

          if (!matchedUids.length) {
            return { messages: [], info: { ...baseInfo, scanned: 0, filteredClientSide: 0 } };
          }

          // Cap to avoid protocol and memory issues. When capped, take the highest UIDs
          // (most recently arrived in folder) as the best approximation of recency.
          const capped = matchedUids.length > FETCH_CANDIDATES_CAP;
          const fetchTargets = capped
            ? [...matchedUids].sort((a, b) => b - a).slice(0, FETCH_CANDIDATES_CAP)
            : matchedUids;

          const fetchQuery = buildFetchQuery(
            { uid: true, envelope: true, flags: true, internalDate: true },
            { threadId: true, bodyStructure: fetchMode === "bodyStructure" }
          );
          if (fetchMode === "source") (fetchQuery as any).source = true;

          const matches: MessageSummary[] = [];
          let scanned = 0;
          let filteredClientSide = 0;
          let timedOut = false;
          const deadline = Date.now() + SEARCH_FETCH_TIMEOUT_MS;

          try {
            for await (const item of client.fetch(buildImapSequenceSet(fetchTargets), fetchQuery, { uid: true })) {
              if (Date.now() > deadline) { timedOut = true; break; }
              scanned++;

              let bodyText = "";
              let attachmentCount: number | undefined;

              if (fetchMode === "source" && item.source) {
                const parsed = await withTimeout(
                  simpleParser(await readSourceText(item.source)),
                  Math.max(1000, deadline - Date.now()),
                  "simpleParser"
                );
                const textBody = (parsed.text ?? "").trim();
                bodyText = textBody || (typeof parsed.html === "string" ? htmlToText(parsed.html) : "");
                attachmentCount = (parsed.attachments ?? []).length;
              } else if (fetchMode === "bodyStructure") {
                attachmentCount = bsHasAttachment((item as any).bodyStructure) ? 1 : 0;
              }

              const summary = toSummary(mailbox, item, bodyText, attachmentCount);

              if (queryGroups.length > 0) {
                const haystack = lower(`${summary.subject} ${summary.from} ${summary.to} ${summary.cc} ${bodyText}`);
                if (!queryGroups.some((group) => group.every((term) => haystack.includes(lower(term))))) {
                  filteredClientSide++;
                  continue;
                }
              }
              if (effective.hasAttachment === true && !(attachmentCount && attachmentCount > 0)) { filteredClientSide++; continue; }
              if (effective.hasAttachment === false && attachmentCount && attachmentCount > 0) { filteredClientSide++; continue; }

              matches.push(summary);
            }
          } catch (err) {
            if (err instanceof Error && /timed out/i.test(err.message)) timedOut = true;
            else throw err;
          }

          // Sort by internalDate descending — semantically correct ordering by arrival time.
          matches.sort((a, b) => (parseDate(b.date)?.valueOf() ?? 0) - (parseDate(a.date)?.valueOf() ?? 0));

          return {
            messages: matches.slice(0, limit),
            info: {
              ...baseInfo,
              scanned,
              filteredClientSide,
              partial: timedOut
                ? { reason: `fetch loop exceeded ${SEARCH_FETCH_TIMEOUT_MS}ms`, processed: scanned, remaining: Math.max(0, fetchTargets.length - scanned) }
                : capped
                ? { reason: `server returned ${matchedUids.length} matches; fetched most recent ${FETCH_CANDIDATES_CAP}`, processed: fetchTargets.length, remaining: matchedUids.length - fetchTargets.length }
                : undefined,
            },
          };
        })
      );
    },

    async getMessage(params: { mailbox?: string; uid: number }): Promise<FullMessage> {
      const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          const fetchQuery = buildFetchQuery(
            { uid: true, envelope: true, flags: true, internalDate: true, source: true },
            { threadId: true }
          );
          const item = await client.fetchOne(String(params.uid), fetchQuery, { uid: true });
          if (!item) throw new Error(`Message uid ${params.uid} not found`);
          return toFullMessage(mailbox, item);
        })
      );
    },

    async getThread(params: { mailbox?: string; uid: number }): Promise<{
      mailbox: string;
      threadId: string;
      messages: FullMessage[];
    }> {
      const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          if (!isGmailHost(cfg.imap.host) || !clientHasGmailExt(client)) {
            throw new Error(
              "gmail_thread_get requires the X-GM-EXT-1 IMAP extension (Gmail). Use gmail_message_get for a single message."
            );
          }

          // Resolve the thread ID from the seed UID (single lightweight fetch)
          const seedQuery = buildFetchQuery({ uid: true }, { threadId: true });
          const seed = await client.fetchOne(String(params.uid), seedQuery, { uid: true });
          const threadId = seed ? getGmailThreadId(seed) : undefined;
          if (!threadId) throw new Error(`Cannot resolve X-GM-THRID for uid ${params.uid}.`);

          // Find all UIDs in the thread, then batch-fetch in a single round-trip
          const matchedRaw = (await client.search({ threadId } as any, { uid: true })) ?? [];
          const uids = (Array.isArray(matchedRaw) ? matchedRaw : []).map(Number).sort((a, b) => a - b);
          if (!uids.length) return { mailbox, threadId, messages: [] };

          const fetchQuery = buildFetchQuery(
            { uid: true, envelope: true, flags: true, internalDate: true, source: true },
            { threadId: true }
          );
          const messages: FullMessage[] = [];
          for await (const item of client.fetch(buildImapSequenceSet(uids), fetchQuery, { uid: true })) {
            messages.push(await toFullMessage(mailbox, item));
          }

          messages.sort((a, b) => (parseDate(a.date)?.valueOf() ?? 0) - (parseDate(b.date)?.valueOf() ?? 0));
          return { mailbox, threadId, messages };
        })
      );
    },

    async downloadAttachments(params: { mailbox?: string; uid: number; filenames?: string[]; subdir?: string }) {
      const mailbox = params.mailbox?.trim() || cfg.defaultMailbox;
      const filterSet = params.filenames?.length ? new Set(params.filenames.map(String)) : null;
      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          const fetchQuery = buildFetchQuery(
            { uid: true, envelope: true, flags: true, internalDate: true, source: true },
            { threadId: true }
          );
          const item = await client.fetchOne(String(params.uid), fetchQuery, { uid: true });
          if (!item) throw new Error(`Message uid ${params.uid} not found`);
          const parsed: ParsedMail = await simpleParser(await readSourceText(item.source));
          const safeMailbox = sanitizeFsName(mailbox, "INBOX");
          const baseDir = params.subdir
            ? join(cfg.attachmentsDir, sanitizeFsName(params.subdir, "misc"))
            : cfg.attachmentsDir;
          const targetDir = join(baseDir, `${safeMailbox}-${params.uid}`);
          await mkdir(targetDir, { recursive: true });
          const saved: { filename: string; path: string; contentType?: string; size: number }[] = [];
          const skipped: { filename: string; reason: string }[] = [];
          let i = 0;
          for (const att of (parsed.attachments ?? []) as ParsedAttachment[]) {
            i++;
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
            saved.push({ filename, path, contentType: att.contentType, size: att.size ?? att.content.length });
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

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatMailboxList(mailboxes: Array<{ path: string; name: string; specialUse?: string; flags: string[] }>): string {
  if (!mailboxes.length) return "(no mailboxes)";
  return mailboxes
    .map((mb) => `- ${mb.path}${mb.specialUse ? ` [${mb.specialUse}]` : ""}${mb.flags.length ? ` flags=${mb.flags.join(",")}` : ""}`)
    .join("\n");
}

function formatMessageList(messages: MessageSummary[], info?: SearchInfo): string {
  if (!messages.length) {
    if (!info || info.matchedTotal === 0) return "(no messages match)";
    return `(no messages after client-side filters; matched=${info.matchedTotal}, scanned=${info.scanned}, filtered=${info.filteredClientSide})`;
  }
  const parts = info
    ? [
        `${messages.length} of ${info.matchedTotal} server matches`,
        `mode=${info.fetchMode}`,
        `scanned=${info.scanned}`,
        `filtered=${info.filteredClientSide}`,
        info.gmailRawUsed ? "gmailRaw" : null,
        info.effectiveSince ? `since=${info.effectiveSince.slice(0, 10)}` : null,
        info.pickedOperators?.length ? `extracted=[${info.pickedOperators.join(" ")}]` : null,
        info.effectiveQuery ? `q="${info.effectiveQuery}"` : null,
        info.partial ? `PARTIAL: ${info.partial.reason} (${info.partial.processed}/${info.partial.processed + info.partial.remaining})` : null,
      ].filter(Boolean).join(", ")
    : "";

  return (
    (parts ? `# ${parts}\n\n` : "") +
    messages
      .map((m) => {
        const flags = [m.unread ? "unread" : "", m.flagged ? "flagged" : "", m.hasAttachments ? "attach" : ""].filter(Boolean).join(",");
        return [
          `uid ${m.uid} [${m.mailbox}]${flags ? ` (${flags})` : ""}`,
          `  date: ${m.date ?? "?"}`,
          `  from: ${m.from}`,
          `  subject: ${m.subject}`,
          `  preview: ${m.preview}`,
        ].join("\n");
      })
      .join("\n\n")
  );
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
  lines.push(`subject: ${message.subject}`, `flags: ${message.flags.join(", ") || "(none)"}`);
  if (message.threadId) lines.push(`thread: ${message.threadId}`);
  lines.push(
    message.attachments.length
      ? `attachments: ${message.attachments.map((a) => `${a.filename || a.contentType || "attachment"}${a.size ? ` (${a.size}B)` : ""}`).join(", ")}`
      : "attachments: (none)"
  );
  const bodyHeader =
    message.bodySource === "html-fallback" ? "body (extracted from html):" :
    message.bodySource === "none" ? "body: (no text or html)" : "body:";
  lines.push("", bodyHeader, truncate(message.bodyText || "(empty)", BODY_TEXT_LIMIT));
  return lines.join("\n");
}

function formatThread(bundle: { mailbox: string; threadId: string; messages: FullMessage[] }): string {
  return [
    `Thread ${bundle.threadId} in ${bundle.mailbox} — ${bundle.messages.length} message(s)`,
    "",
    ...bundle.messages.map((m, idx) => {
      const flags = [m.unread ? "unread" : "", m.flagged ? "flagged" : "", m.hasAttachments ? "attach" : ""].filter(Boolean).join(",");
      return [
        `--- [${idx + 1}/${bundle.messages.length}] uid ${m.uid}${flags ? ` (${flags})` : ""}`,
        `date: ${m.date ?? "?"}`,
        `from: ${m.from}`,
        `to: ${m.to}`,
        `subject: ${m.subject}`,
        "",
        truncate(m.bodyText || "(empty)", 1500),
      ].join("\n");
    }),
  ].join("\n");
}

function toolTextResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ─── MCP server ───────────────────────────────────────────────────────────────

type Runtime = ReturnType<typeof createRuntime>;

let runtimeState: { cfg: NormalizedConfig; runtime: Runtime } | undefined;

/** Config is loaded lazily so a missing config produces a helpful tool error instead of a dead server. */
async function getRuntime(): Promise<{ cfg: NormalizedConfig; runtime: Runtime }> {
  if (!runtimeState) {
    const cfg = normalizeConfig(await loadRawConfig());
    runtimeState = { cfg, runtime: createRuntime(cfg) };
  }
  return runtimeState;
}

const recipientSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const attachmentInputSchema = z.object({
  path: z.string().min(1),
  filename: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
});

const server = new McpServer({ name: "gmail-imap", version: "1.1.1" });

server.registerTool(
  "gmail_mailboxes_list",
  {
    title: "List mailboxes",
    description: "List the mailboxes (folders/labels) on the configured account.",
    inputSchema: {},
  },
  async () => {
    const { runtime } = await getRuntime();
    const mailboxes = await runtime.listMailboxes();
    return toolTextResult(formatMailboxList(mailboxes));
  }
);

server.registerTool(
  "gmail_messages_search",
  {
    title: "Search messages",
    description:
      "Server-side IMAP search. `query` accepts free text (AND by default) or `OR` for alternation. Inline Gmail-style operators are auto-extracted: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `in:LABEL`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`. Explicit params win over inline operators. Use `gmailRaw` to pass a raw Gmail search expression (Gmail only). When no date range is provided, defaults to the last 30 days. Paginate by passing `before` with the `date` field of the last seen message.",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      query: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      subject: z.string().min(1).optional(),
      unread: z.boolean().optional(),
      flagged: z.boolean().optional(),
      hasAttachment: z.boolean().optional(),
      since: z.string().min(1).optional(),
      before: z
        .string()
        .min(1)
        .optional()
        .describe("Upper bound on internalDate (ISO or YYYY-MM-DD). Use as pagination cursor."),
      limit: z.number().int().min(1).max(100).optional(),
      gmailRaw: z.string().min(1).optional(),
    },
  },
  async (params: SearchParams) => {
    const { runtime } = await getRuntime();
    const result = await runtime.searchMessages(params);
    return toolTextResult(formatMessageList(result.messages, result.info));
  }
);

server.registerTool(
  "gmail_message_get",
  {
    title: "Get message",
    description:
      "Fetch one message by UID with full body and attachment metadata. HTML-only messages are auto-converted to plain text.",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      uid: z.number().int().min(1),
    },
  },
  async (params: { mailbox?: string; uid: number }) => {
    const { runtime } = await getRuntime();
    const message = await runtime.getMessage(params);
    return toolTextResult(formatMessage(message));
  }
);

server.registerTool(
  "gmail_thread_get",
  {
    title: "Get thread (Gmail)",
    description:
      "Fetch all messages in the same Gmail thread as the given UID, ordered chronologically. Requires Gmail (X-GM-EXT-1). All thread messages are fetched in a single IMAP round-trip.",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      uid: z.number().int().min(1),
    },
  },
  async (params: { mailbox?: string; uid: number }) => {
    const { runtime } = await getRuntime();
    const bundle = await runtime.getThread(params);
    return toolTextResult(formatThread(bundle));
  }
);

server.registerTool(
  "gmail_message_attachments_save",
  {
    title: "Save attachments",
    description:
      "Download all (or filtered) attachments of one message to the configured attachments directory. Returns absolute paths the agent can read directly. Optional `subdir` nests the per-message folder under a subdirectory of the attachments dir (e.g. a year like \"2026\").",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      uid: z.number().int().min(1),
      filenames: z.array(z.string().min(1)).optional(),
      subdir: z.string().min(1).optional(),
    },
  },
  async (params: { mailbox?: string; uid: number; filenames?: string[]; subdir?: string }) => {
    const { runtime } = await getRuntime();
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
    return toolTextResult(lines.join("\n"));
  }
);

server.registerTool(
  "gmail_message_update",
  {
    title: "Update flags",
    description: "Mark one message as read/unread and/or set/clear its starred state.",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      uid: z.number().int().min(1),
      read: z.boolean().optional(),
      flagged: z.boolean().optional(),
    },
  },
  async (params: { mailbox?: string; uid: number; read?: boolean; flagged?: boolean }) => {
    if (typeof params.read !== "boolean" && typeof params.flagged !== "boolean") {
      throw new Error("Provide at least one flag update: read and/or flagged.");
    }
    const { runtime } = await getRuntime();
    const result = await runtime.updateMessage(params);
    return toolTextResult(
      `Updated ${result.mailbox} uid ${result.uid}${typeof result.read === "boolean" ? ` read=${result.read}` : ""}${typeof result.flagged === "boolean" ? ` flagged=${result.flagged}` : ""}`
    );
  }
);

server.registerTool(
  "gmail_message_move",
  {
    title: "Move message",
    description: "Move one message to another mailbox.",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      uid: z.number().int().min(1),
      destinationMailbox: z.string().min(1),
    },
  },
  async (params: { mailbox?: string; uid: number; destinationMailbox: string }) => {
    const { runtime } = await getRuntime();
    const result = await runtime.moveMessage(params);
    return toolTextResult(`Moved uid ${result.uid} from ${result.sourceMailbox} to ${result.destinationMailbox}`);
  }
);

server.registerTool(
  "gmail_message_send",
  {
    title: "Send message",
    description: "Send a new email. With requireExplicitSendConfirmation=true (default), must pass confirm=true.",
    inputSchema: {
      to: recipientSchema,
      cc: recipientSchema.optional(),
      bcc: recipientSchema.optional(),
      subject: z.string().min(1),
      text: z.string().optional(),
      html: z.string().optional(),
      attachments: z.array(attachmentInputSchema).optional(),
      confirm: z.boolean().optional(),
    },
  },
  async (params: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    text?: string;
    html?: string;
    attachments?: { path: string; filename?: string; contentType?: string }[];
    confirm?: boolean;
  }) => {
    const { cfg, runtime } = await getRuntime();
    if (cfg.requireExplicitSendConfirmation && params.confirm !== true) {
      return toolTextResult(
        "Refusing to send: requireExplicitSendConfirmation is enabled and confirm=true was not provided."
      );
    }
    if (!params.text && !params.html) throw new Error("Provide text and/or html body");
    const result = await runtime.sendMessage(params);
    return toolTextResult(
      `Sent. accepted=[${result.accepted.join(", ")}] rejected=[${result.rejected.join(", ")}] subject="${result.subject}"`
    );
  }
);

server.registerTool(
  "gmail_message_reply",
  {
    title: "Reply to message",
    description: "Reply to an existing message by UID. replyAll=true CCs all original recipients (excluding self).",
    inputSchema: {
      mailbox: z.string().min(1).optional(),
      uid: z.number().int().min(1),
      text: z.string().optional(),
      html: z.string().optional(),
      replyAll: z.boolean().optional(),
      attachments: z.array(attachmentInputSchema).optional(),
      confirm: z.boolean().optional(),
    },
  },
  async (params: {
    mailbox?: string;
    uid: number;
    text?: string;
    html?: string;
    replyAll?: boolean;
    attachments?: { path: string; filename?: string; contentType?: string }[];
    confirm?: boolean;
  }) => {
    const { cfg, runtime } = await getRuntime();
    if (cfg.requireExplicitSendConfirmation && params.confirm !== true) {
      return toolTextResult(
        "Refusing to reply: requireExplicitSendConfirmation is enabled and confirm=true was not provided."
      );
    }
    if (!params.text && !params.html) throw new Error("Provide text and/or html body");
    const original = await runtime.getMessage(params);
    const ownAddresses = uniqueStrings([lower(cfg.from), lower(cfg.username)]);
    const replyTarget = original.replyTo || original.from;
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const messageIdRef = original.messageId
      ? `<${String(original.messageId).replace(/^<|>$/g, "")}>`
      : undefined;
    const references = uniqueStrings([...(original.references ?? []), messageIdRef ?? ""].filter(Boolean));
    let to: string[];
    let cc: string[] = [];
    if (params.replyAll) {
      const all = uniqueStrings(
        [replyTarget, original.to, original.cc].join(",").split(",").map((s) => s.trim()).filter(Boolean)
      ).filter((addr) => !ownAddresses.includes(lower(addr)));
      to = all.slice(0, 1);
      cc = all.slice(1);
    } else {
      to = [replyTarget].filter(Boolean);
    }
    const quoted = original.bodyText
      ? `\n\nOn ${original.date ?? ""}, ${original.from} wrote:\n${original.bodyText.split("\n").map((l) => `> ${l}`).join("\n")}`
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
    return toolTextResult(`Replied. accepted=[${result.accepted.join(", ")}] subject="${result.subject}"`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("gmail-imap MCP server running on stdio");
}

main().catch((err) => {
  console.error("gmail-imap fatal:", err);
  process.exit(1);
});
