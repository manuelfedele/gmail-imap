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
const DEFAULT_SINCE_DAYS = 30;
const BODY_TEXT_LIMIT = 4000;
const FETCH_CANDIDATES_CAP = 1000;
const SEARCH_FETCH_TIMEOUT_MS = 30_000;
const IMAP_CONNECT_TIMEOUT_MS = 10_000;
const IMAP_RETRY_ATTEMPTS = 3;
const IMAP_RETRY_DELAYS_MS = [100, 500, 2000];

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
  if (typeof source === "string") return source;
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
  const subject = item.envelope?.subject ?? "";
  const from = formatAddressList(item.envelope?.from);
  const to = formatAddressList(item.envelope?.to);
  const cc = formatAddressList(item.envelope?.cc);
  const previewSource = compactWhitespace(bodyText) || compactWhitespace(subject) || "";
  const messageId = Array.isArray(item.envelope?.messageId)
    ? item.envelope?.messageId[0]
    : item.envelope?.messageId;
  const threadId = (item as any).threadId ? String((item as any).threadId) : undefined;
  return {
    mailbox,
    uid: Number(item.uid),
    subject,
    from,
    to,
    cc,
    date: item.internalDate ? new Date(item.internalDate).toISOString() : null,
    preview: truncate(previewSource, 200),
    flags,
    unread: !flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    hasAttachments: typeof attachmentCount === "number" ? attachmentCount > 0 : false,
    messageId,
    threadId,
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
  const references = Array.isArray(refs) ? refs.map(String) : refs ? [String(refs)] : [];
  return {
    ...summary,
    bodyText,
    html,
    attachments: attachments.map((a) => ({
      filename: a.filename ?? undefined,
      contentType: a.contentType,
      size: a.size,
    })),
    replyTo: parsed.replyTo?.text ?? "",
    references,
    bodySource,
  };
}

async function withImapClient<T>(
  cfg: NormalizedConfig,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
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
          setTimeout(() => reject(new Error(`IMAP connect timed out after ${IMAP_CONNECT_TIMEOUT_MS}ms`)), IMAP_CONNECT_TIMEOUT_MS)
        ),
      ]);
      try {
        return await fn(client);
      } finally {
        try {
          await client.logout();
        } catch {
          // best-effort
        }
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
    { uid: true, envelope: true, flags: true, internalDate: true, source: true, threadId: true } as FetchQueryObject,
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

function isGmailHost(host: string): boolean {
  return /(?:^|\.)gmail\.com$/i.test(host) || /(?:^|\.)googlemail\.com$/i.test(host);
}

/**
 * Strip Gmail-style operators (`from:X`, `subject:"foo bar"`, `has:attachment`,
 * `is:unread`, `is:starred`, `in:LABEL`, `label:LABEL`, `before:`, `after:`,
 * `since:`) out of `query` and merge them into the explicit params. Explicit
 * params win over inline operators. Returns the cleaned remainder text.
 */
function extractGmailOperators(
  query: string
): {
  remaining: string;
  parsed: Pick<
    SearchParams,
    "from" | "to" | "subject" | "unread" | "flagged" | "hasAttachment" | "since" | "before" | "mailbox"
  >;
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
      case "from":
        if (parsed.from === undefined) parsed.from = value;
        consumed = true;
        break;
      case "to":
        if (parsed.to === undefined) parsed.to = value;
        consumed = true;
        break;
      case "subject":
        if (parsed.subject === undefined) parsed.subject = value;
        consumed = true;
        break;
      case "has":
        if (/attachment/i.test(value)) {
          parsed.hasAttachment = true;
          consumed = true;
        }
        break;
      case "is":
        if (/^unread$/i.test(value)) {
          parsed.unread = true;
          consumed = true;
        } else if (/^read$/i.test(value)) {
          parsed.unread = false;
          consumed = true;
        } else if (/^(?:flagged|starred)$/i.test(value)) {
          parsed.flagged = true;
          consumed = true;
        }
        break;
      case "in":
      case "label":
        if (parsed.mailbox === undefined) parsed.mailbox = value;
        consumed = true;
        break;
      case "before":
        if (parsed.before === undefined) parsed.before = normalizeGmailDate(value);
        consumed = true;
        break;
      case "after":
      case "since":
        if (parsed.since === undefined) parsed.since = normalizeGmailDate(value);
        consumed = true;
        break;
    }
    if (consumed) {
      ranges.push([m.index, m.index + m[0].length]);
      picked.push(`${key}:${value}`);
    }
  }
  // Build the remaining text by removing the consumed ranges
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

function normalizeGmailDate(v: string): string {
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return v;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v)) return v.replace(/\//g, "-");
  return v;
}

/**
 * Parse a free-text query into a CNF-like structure: an array of OR groups,
 * each containing AND terms. `"foo bar"` -> [["foo","bar"]] (1 group, AND).
 * `"foo OR bar"` -> [["foo"],["bar"]] (2 groups, either matches).
 * Operator tokens "OR" / "AND" are stripped (case-insensitive).
 */
function parseQueryGroups(query: string | undefined): string[][] {
  if (!query) return [];
  const cleaned = query.trim();
  if (!cleaned) return [];
  const orGroups = cleaned.split(/\s+OR\s+/i);
  return orGroups
    .map((g) =>
      g
        .split(/\s+/)
        .filter((t) => t && !/^(?:AND|OR)$/i.test(t))
    )
    .filter((g) => g.length > 0);
}

/** Walk an imapflow bodyStructure and return true if any part looks like an attachment. */
function bsHasAttachment(bs: any): boolean {
  if (!bs) return false;
  const dispo = String(bs.disposition || "").toLowerCase();
  if (dispo === "attachment") return true;
  const filename =
    bs.dispositionParameters?.filename ||
    bs.dispositionParameters?.name ||
    bs.parameters?.name ||
    bs.parameters?.filename;
  const type = String(bs.type || "").toLowerCase();
  if (filename && type !== "multipart" && !type.startsWith("text/")) return true;
  if (Array.isArray(bs.childNodes) && bs.childNodes.some(bsHasAttachment)) return true;
  if (Array.isArray(bs.parts) && bs.parts.some(bsHasAttachment)) return true;
  return false;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function clientHasGmailExt(client: ImapFlow): boolean {
  try {
    const caps = (client as any).serverInfo?.capability ?? [];
    return Array.isArray(caps) && caps.some((c: string) => /X-GM-EXT-1/i.test(String(c)));
  } catch {
    return false;
  }
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
  beforeUid?: number;
  gmailRaw?: string;
}

interface SearchInfo {
  serverSearchUsed: boolean;
  matchedTotal: number;
  scanned: number;
  filteredClientSide: number;
  truncatedAt?: number;
  gmailRawUsed?: boolean;
  fetchMode?: "envelope" | "bodyStructure" | "source";
  partial?: { reason: string; processed: number; remaining: number };
  pickedOperators?: string[];
  effectiveQuery?: string;
}

interface SearchResultBundle {
  messages: MessageSummary[];
  info: SearchInfo;
}

function buildServerCriteria(
  params: SearchParams,
  serverBodyTerm: string | undefined,
  client: ImapFlow,
  cfg: NormalizedConfig
): { criteria: any; gmailRawUsed: boolean } {
  if (params.gmailRaw) {
    if (!isGmailHost(cfg.imap.host) || !clientHasGmailExt(client)) {
      throw new Error("gmailRaw was provided but the connected server does not advertise X-GM-EXT-1. Use a Gmail account or remove gmailRaw.");
    }
    return { criteria: { gmailRaw: params.gmailRaw }, gmailRawUsed: true };
  }
  const criteria: any = {};
  if (params.from) criteria.from = params.from;
  if (params.to) criteria.to = params.to;
  if (params.subject) criteria.subject = params.subject;
  if (params.since) {
    const d = parseDate(params.since);
    if (d) criteria.since = d;
  }
  if (params.before) {
    const d = parseDate(params.before);
    if (d) criteria.before = d;
  }
  if (params.unread === true) criteria.unseen = true;
  if (params.unread === false) criteria.seen = true;
  if (params.flagged === true) criteria.flagged = true;
  if (params.flagged === false) criteria.unflagged = true;
  if (serverBodyTerm) criteria.body = serverBodyTerm;
  if (typeof params.beforeUid === "number" && params.beforeUid > 0) {
    criteria.uid = `1:${params.beforeUid - 1}`;
  }
  return { criteria, gmailRawUsed: false };
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

    async searchMessages(params: SearchParams): Promise<SearchResultBundle> {
      // Pre-parse Gmail-style operators (`from:X subject:Y has:attachment is:unread`)
      // out of the free-text query and merge into params. Explicit params win.
      let pickedOperators: string[] = [];
      let effective: SearchParams = params;
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
      // When no temporal filter is given, default to the last DEFAULT_SINCE_DAYS days.
      // This prevents scanning thousands of old messages and ensures recent mail is always visible.
      if (!effective.since && !effective.before && !effective.gmailRaw && !effective.beforeUid) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - DEFAULT_SINCE_DAYS);
        effective = { ...effective, since: cutoff.toISOString() };
      }

      const mailbox = effective.mailbox?.trim() || cfg.defaultMailbox;
      const limit = Math.min(effective.limit ?? cfg.defaultSearchLimit, 100);
      const queryGroups = parseQueryGroups(effective.query);
      // Use server-side BODY only if there's exactly one OR group with one AND term.
      // Otherwise we'd over-narrow on the server.
      const serverBodyTerm =
        queryGroups.length === 1 && queryGroups[0].length === 1 ? queryGroups[0][0] : undefined;
      const needsClientQueryFilter = queryGroups.length > 0 && !serverBodyTerm;
      const needsAttachmentFilter = effective.hasAttachment !== undefined;
      // Source is only needed for multi-term/OR query filtering against the body.
      // For hasAttachment alone, BODYSTRUCTURE is enough and ~100x cheaper.
      const fetchMode: "envelope" | "bodyStructure" | "source" = needsClientQueryFilter
        ? "source"
        : needsAttachmentFilter
        ? "bodyStructure"
        : "envelope";

      return withImapClient(cfg, (client) =>
        withMailboxLock(client, mailbox, async () => {
          const { criteria, gmailRawUsed } = buildServerCriteria(effective, serverBodyTerm, client, cfg);
          const matchedRaw = (await client.search(criteria, { uid: true })) || [];
          const matchedUids: number[] = (Array.isArray(matchedRaw) ? matchedRaw : []).map(Number);
          if (!matchedUids.length) {
            return {
              messages: [],
              info: {
                serverSearchUsed: true,
                matchedTotal: 0,
                scanned: 0,
                filteredClientSide: 0,
                gmailRawUsed,
                fetchMode,
                pickedOperators: pickedOperators.length ? pickedOperators : undefined,
                effectiveQuery: effective.query,
              },
            };
          }

          // Server already filtered by date (SINCE/BEFORE) — fetch all candidates and
          // sort by internalDate client-side. Cap at FETCH_CANDIDATES_CAP for safety.
          const capped = matchedUids.length > FETCH_CANDIDATES_CAP;
          const fetchTargets = capped ? matchedUids.slice(-FETCH_CANDIDATES_CAP) : matchedUids;
          const truncatedAt = capped ? fetchTargets[0] : undefined;

          const fetchQuery: FetchQueryObject = {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            threadId: true,
          } as FetchQueryObject;
          if (fetchMode === "source") fetchQuery.source = true;
          if (fetchMode === "bodyStructure") (fetchQuery as any).bodyStructure = true;

          const matches: MessageSummary[] = [];
          let scanned = 0;
          let filteredClientSide = 0;
          let timedOut = false;
          const deadline = Date.now() + SEARCH_FETCH_TIMEOUT_MS;

          try {
            for await (const item of client.fetch(fetchTargets.join(","), fetchQuery, { uid: true })) {
              if (Date.now() > deadline) {
                timedOut = true;
                break;
              }
              scanned += 1;
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

              if (needsClientQueryFilter) {
                const haystack = lower(
                  `${summary.subject} ${summary.from} ${summary.to} ${summary.cc} ${bodyText}`
                );
                const matchesAnyGroup = queryGroups.some((group) =>
                  group.every((term) => haystack.includes(lower(term)))
                );
                if (!matchesAnyGroup) {
                  filteredClientSide += 1;
                  continue;
                }
              }
              if (effective.hasAttachment === true && !(attachmentCount && attachmentCount > 0)) {
                filteredClientSide += 1;
                continue;
              }
              if (effective.hasAttachment === false && attachmentCount && attachmentCount > 0) {
                filteredClientSide += 1;
                continue;
              }
              matches.push(summary);
            }
          } catch (err) {
            if (err instanceof Error && /timed out/i.test(err.message)) {
              timedOut = true;
            } else {
              throw err;
            }
          }

          matches.sort((a, b) => {
            const da = parseDate(a.date ?? undefined)?.valueOf() ?? 0;
            const db = parseDate(b.date ?? undefined)?.valueOf() ?? 0;
            return db - da || b.uid - a.uid;
          });
          return {
            messages: matches.slice(0, limit),
            info: {
              serverSearchUsed: true,
              matchedTotal: matchedUids.length,
              scanned,
              filteredClientSide,
              truncatedAt,
              gmailRawUsed,
              fetchMode,
              pickedOperators: pickedOperators.length ? pickedOperators : undefined,
              effectiveQuery: effective.query,
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
          const item = await fetchMessageByUid(client, params.uid);
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
              "gmail_thread_get requires the X-GM-EXT-1 IMAP extension (Gmail). Switch to a Gmail account or use gmail_message_get for a single message."
            );
          }
          const seed = await client.fetchOne(
            String(params.uid),
            { uid: true, threadId: true } as FetchQueryObject,
            { uid: true }
          );
          if (!seed || !(seed as any).threadId) {
            throw new Error(`Cannot resolve X-GM-THRID for uid ${params.uid}.`);
          }
          const threadId = String((seed as any).threadId);
          const matched = (await client.search({ threadId } as any, { uid: true })) || [];
          const uids = (Array.isArray(matched) ? matched : []).map(Number).sort((a, b) => a - b);
          const messages: FullMessage[] = [];
          for (const uid of uids) {
            const item = await fetchMessageByUid(client, uid);
            messages.push(await toFullMessage(mailbox, item));
          }
          messages.sort((a, b) => {
            const da = parseDate(a.date ?? undefined)?.valueOf() ?? 0;
            const db = parseDate(b.date ?? undefined)?.valueOf() ?? 0;
            return da - db || a.uid - b.uid;
          });
          return { mailbox, threadId, messages };
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

function formatMessageList(messages: MessageSummary[], info?: SearchInfo): string {
  if (!messages.length) {
    if (info && info.matchedTotal === 0) {
      return "(no messages match)";
    }
    if (info) {
      return `(no messages after client-side filters; matched=${info.matchedTotal}, scanned=${info.scanned}, filtered=${info.filteredClientSide})`;
    }
    return "(no messages)";
  }
  const head = info
    ? `# ${messages.length} of ${info.matchedTotal} server matches (mode=${info.fetchMode}, scanned=${info.scanned}, filtered=${info.filteredClientSide}${info.gmailRawUsed ? ", gmailRaw" : ""}${info.pickedOperators?.length ? `, extracted=[${info.pickedOperators.join(" ")}]` : ""}${info.effectiveQuery ? `, q="${info.effectiveQuery}"` : ""}${info.truncatedAt ? `, truncatedAtUid=${info.truncatedAt}` : ""}${info.partial ? `, PARTIAL: ${info.partial.reason} (${info.partial.processed}/${info.partial.processed + info.partial.remaining})` : ""})\n\n`
    : "";
  return (
    head +
    messages
      .map((m) => {
        const flags = [
          m.unread ? "unread" : "",
          m.flagged ? "flagged" : "",
          m.hasAttachments ? "attach" : "",
        ]
          .filter(Boolean)
          .join(",");
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
  lines.push(`subject: ${message.subject}`);
  lines.push(`flags: ${message.flags.join(", ") || "(none)"}`);
  if (message.threadId) lines.push(`thread: ${message.threadId}`);
  if (message.attachments.length) {
    lines.push(
      `attachments: ${message.attachments
        .map((a) => `${a.filename || a.contentType || "attachment"}${a.size ? ` (${a.size}B)` : ""}`)
        .join(", ")}`
    );
  } else {
    lines.push("attachments: (none)");
  }
  const bodyHeader =
    message.bodySource === "html-fallback"
      ? "body (extracted from html):"
      : message.bodySource === "none"
      ? "body: (no text or html)"
      : "body:";
  lines.push("", bodyHeader, truncate(message.bodyText || "(empty)", BODY_TEXT_LIMIT));
  return lines.join("\n");
}

function formatThread(bundle: { mailbox: string; threadId: string; messages: FullMessage[] }): string {
  const head = `Thread ${bundle.threadId} in ${bundle.mailbox} — ${bundle.messages.length} message(s)`;
  const items = bundle.messages.map((m, idx) => {
    const flags = [m.unread ? "unread" : "", m.flagged ? "flagged" : "", m.hasAttachments ? "attach" : ""]
      .filter(Boolean)
      .join(",");
    return [
      `--- [${idx + 1}/${bundle.messages.length}] uid ${m.uid}${flags ? ` (${flags})` : ""}`,
      `date: ${m.date ?? "?"}`,
      `from: ${m.from}`,
      `to: ${m.to}`,
      `subject: ${m.subject}`,
      "",
      truncate(m.bodyText || "(empty)", 1500),
    ].join("\n");
  });
  return [head, "", ...items].join("\n");
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
  description: "Read, search (server-side IMAP + Gmail X-GM-RAW), send, reply, organize, and download attachments using a Gmail App Password.",
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
      label: "Search messages (server-side)",
      description:
        "Server-side IMAP search across the entire mailbox. `query` accepts free text with AND-by-default plus literal `OR` for alternation, e.g. `fattura OR invoice`. Inline Gmail-style operators inside `query` are auto-extracted into the right server-side filters: `from:foo@bar`, `to:x`, `subject:\"hello world\"`, `has:attachment`, `is:unread`, `is:starred`, `in:LABEL` / `label:LABEL`, `before:2026-04-01`, `after:2025-01-01` (`/` or `-` date separators OK). Explicit params win over inline operators. Use `gmailRaw` to bypass parsing entirely and pass a raw Gmail web-search expression (Gmail accounts only). Other params: `from`, `to`, `subject`, `unread`, `flagged`, `hasAttachment`, `since`, `before`, `beforeUid` (cursor for pagination). Default `limit` 10, max 100.",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        query: Type.Optional(Type.String({ minLength: 1 })),
        from: Type.Optional(Type.String({ minLength: 1 })),
        to: Type.Optional(Type.String({ minLength: 1 })),
        subject: Type.Optional(Type.String({ minLength: 1 })),
        unread: Type.Optional(Type.Boolean()),
        flagged: Type.Optional(Type.Boolean()),
        hasAttachment: Type.Optional(Type.Boolean()),
        since: Type.Optional(Type.String({ minLength: 1 })),
        before: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        beforeUid: Type.Optional(Type.Integer({ minimum: 1 })),
        gmailRaw: Type.Optional(Type.String({ minLength: 1 })),
      }),
      async execute(_id: unknown, params: SearchParams) {
        const result = await runtime.searchMessages(params);
        return toolTextResult(formatMessageList(result.messages, result.info), {
          status: "ok",
          count: result.messages.length,
          messages: result.messages,
          info: result.info,
        });
      },
    });

    api.registerTool({
      name: "gmail_message_get",
      label: "Get message",
      description:
        "Fetch one message by UID with body and attachment metadata. If the message has only HTML, the body is auto-extracted to plain text (bodySource='html-fallback').",
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
      name: "gmail_thread_get",
      label: "Get thread (Gmail)",
      description:
        "Fetch every message in the same Gmail thread as the given UID, ordered chronologically. Requires the IMAP X-GM-EXT-1 extension (Gmail).",
      parameters: Type.Object({
        mailbox: Type.Optional(Type.String({ minLength: 1 })),
        uid: Type.Integer({ minimum: 1 }),
      }),
      async execute(_id: unknown, params: { mailbox?: string; uid: number }) {
        const bundle = await runtime.getThread(params);
        return toolTextResult(formatThread(bundle), { status: "ok", ...bundle });
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
