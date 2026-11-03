import { ApiClient, clip, type PollResult } from './base.js';
import { IntegrationError } from './http.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';

export interface MailSummary { id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string; labels: string[] }
export interface MailMessage extends MailSummary { body: string }
export interface CalEvent { id: string; summary: string; start: string; end: string; location: string; attendees: string[]; organizer: string; status: string; url: string }
export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string; url: string }

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Array<{ name: string; value: string }> };
type RawMsg = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: Part };
type RawEvent = {
  id: string; summary?: string; status?: string; location?: string; htmlLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string }>; organizer?: { email?: string };
};

const header = (p: Part | undefined, name: string) =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function summary(m: RawMsg): MailSummary {
  return {
    id: m.id, threadId: m.threadId, from: header(m.payload, 'From'), to: header(m.payload, 'To'),
    subject: header(m.payload, 'Subject'), date: header(m.payload, 'Date'), snippet: m.snippet ?? '', labels: m.labelIds ?? [],
  };
}

/** The first text/plain part, else text/html with the tags stripped. */
function bodyText(p: Part | undefined): string {
  if (!p) return '';
  const find = (part: Part, type: string): string | null => {
    if (part.mimeType === type && part.body?.data) return b64url(part.body.data);
    for (const c of part.parts ?? []) {
      const hit = find(c, type);
      if (hit !== null) return hit;
    }
    return null;
  };
  const plain = find(p, 'text/plain');
  if (plain !== null) return plain;
  const html = find(p, 'text/html');
  if (html !== null) return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return p.body?.data ? b64url(p.body.data) : '';
}

function toEvent(e: RawEvent): CalEvent {
  return {
    id: e.id, summary: e.summary ?? '(no title)', status: e.status ?? '', location: e.location ?? '',
    start: e.start?.dateTime ?? e.start?.date ?? '', end: e.end?.dateTime ?? e.end?.date ?? '',
    attendees: (e.attendees ?? []).map((a) => a.email), organizer: e.organizer?.email ?? '', url: e.htmlLink ?? '',
  };
}

/** One header line. CR/LF would let a bot smuggle extra headers (Bcc:) into the message. */
function headerValue(name: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new IntegrationError(name + ' must be a single line', 400);
  return v;
}

/** Encode a header value as RFC 2047 when it is not plain ASCII. */
function encodeWord(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
}

export class GoogleClient extends ApiClient {
  async whoami(): Promise<{ email: string }> {
    const r = await this.call<{ email?: string }>('https://openidconnect.googleapis.com/v1/userinfo');
    return { email: r.data.email ?? '' };
  }

  // ---------- Gmail ----------
  /** Gmail search syntax: `from:x is:unread newer_than:2d`. */
  async gmailSearch(q: string, limit = 10): Promise<MailSummary[]> {
    const r = await this.call<{ messages?: Array<{ id: string }> }>(GMAIL + '/messages', { query: { q, maxResults: Math.min(limit, 25) } });
    const out: MailSummary[] = [];
    for (const m of r.data.messages ?? []) {
      // format=metadata without metadataHeaders returns every header and no body.
      const full = await this.call<RawMsg>(GMAIL + '/messages/' + encodeURIComponent(m.id), { query: { format: 'metadata' } });
      out.push(summary(full.data));
    }
    return out;
  }

  async gmailRead(id: string): Promise<MailMessage> {
    const r = await this.call<RawMsg>(GMAIL + '/messages/' + encodeURIComponent(id), { query: { format: 'full' } });
    return { ...summary(r.data), body: clip(bodyText(r.data.payload)) };
  }

  async gmailSend(m: { to: string; subject: string; body: string; cc?: string; threadId?: string; inReplyTo?: string }): Promise<{ id: string; threadId: string }> {
    const lines = [
      'To: ' + headerValue('to', m.to),
      ...(m.cc ? ['Cc: ' + headerValue('cc', m.cc)] : []),
      'Subject: ' + encodeWord(headerValue('subject', m.subject)),
      ...(m.inReplyTo ? ['In-Reply-To: ' + headerValue('inReplyTo', m.inReplyTo), 'References: ' + m.inReplyTo] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(m.body, 'utf8').toString('base64'),
    ];
    const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
    const r = await this.call<{ id: string; threadId: string }>(GMAIL + '/messages/send', { method: 'POST', json: { raw, threadId: m.threadId } });
    return { id: r.data.id, threadId: r.data.threadId };
  }

  /** Poll API (P5) seed: the mailbox's current historyId. */
  async seedGmailHistory(): Promise<string> {
    const r = await this.call<{ historyId: string }>(GMAIL + '/profile');
    return String(r.data.historyId);
  }

  /**
   * Poll API (P5): message ids added since `cursor` (a historyId). A 404 means the historyId is too old:
   * `resync` is set and the caller re-seeds with `seedGmailHistory()`.
   */
  async pollGmail(o: { cursor: string }): Promise<PollResult<{ id: string; threadId: string; labels: string[] }>> {
    const items: Array<{ id: string; threadId: string; labels: string[] }> = [];
    let pageToken: string | undefined;
    let cursor = o.cursor;
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }> }>; historyId?: string; nextPageToken?: string }>(
        GMAIL + '/history', { query: { startHistoryId: o.cursor, historyTypes: 'messageAdded', pageToken }, allow: [404] },
      );
      if (r.status === 404) return { items: [], cursor: null, notModified: false, resync: true };
      for (const h of r.data.history ?? []) for (const a of h.messagesAdded ?? []) items.push({ id: a.message.id, threadId: a.message.threadId, labels: a.message.labelIds ?? [] });
      if (r.data.historyId) cursor = String(r.data.historyId);
      if (!r.data.nextPageToken) break;
      pageToken = r.data.nextPageToken;
    }
    return { items, cursor, notModified: items.length === 0, resync: false };
  }

  // ---------- Calendar ----------
  async calendarList(o: { timeMin?: string; timeMax?: string; q?: string; limit?: number; calendarId?: string } = {}): Promise<CalEvent[]> {
    const r = await this.call<{ items?: RawEvent[] }>(CAL + '/calendars/' + encodeURIComponent(o.calendarId ?? 'primary') + '/events', {
      query: { timeMin: o.timeMin ?? new Date().toISOString(), timeMax: o.timeMax, q: o.q, maxResults: Math.min(o.limit ?? 20, 100), singleEvents: true, orderBy: 'startTime' },
    });
    return (r.data.items ?? []).map(toEvent);
  }

  async calendarCreate(e: { summary: string; start: string; end: string; description?: string; location?: string; attendees?: string[]; timeZone?: string; calendarId?: string }): Promise<CalEvent> {
    const when = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v, timeZone: e.timeZone });
    const r = await this.call<RawEvent>(CAL + '/calendars/' + encodeURIComponent(e.calendarId ?? 'primary') + '/events', {
      method: 'POST',
      json: {
        summary: e.summary, description: e.description, location: e.location, start: when(e.start), end: when(e.end),
        attendees: e.attendees?.map((email) => ({ email })),
      },
    });
    return toEvent(r.data);
  }

  /**
   * Poll API (P5): changed events since `cursor` (a syncToken). With no cursor it pages through the whole
   * calendar once and returns the first syncToken. A 410 means the token expired: `resync` is set.
   */
  async pollCalendar(o: { cursor?: string | null; calendarId?: string } = {}): Promise<PollResult<CalEvent>> {
    const items: CalEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.call<{ items?: RawEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
        CAL + '/calendars/' + encodeURIComponent(o.calendarId ?? 'primary') + '/events',
        { query: { syncToken: o.cursor ?? undefined, pageToken, maxResults: 250, showDeleted: !!o.cursor }, allow: [410] },
      );
      if (r.status === 410) return { items: [], cursor: null, notModified: false, resync: true };
      items.push(...(r.data.items ?? []).map(toEvent));
      if (r.data.nextSyncToken) return { items: o.cursor ? items : [], cursor: r.data.nextSyncToken, notModified: o.cursor ? items.length === 0 : false, resync: false };
      if (!r.data.nextPageToken) break;
      pageToken = r.data.nextPageToken;
    }
    return { items, cursor: o.cursor ?? null, notModified: false, resync: false };
  }

  // ---------- Drive ----------
  async driveSearch(q: string, limit = 10): Promise<DriveFile[]> {
    const esc = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const r = await this.call<{ files?: Array<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }> }>(DRIVE + '/files', {
      query: {
        q: "(name contains '" + esc + "' or fullText contains '" + esc + "') and trashed = false",
        pageSize: Math.min(limit, 50), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', orderBy: 'modifiedTime desc',
      },
    });
    return (r.data.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, url: f.webViewLink ?? '' }));
  }

  /** Text content: Google Docs as plain text, Sheets as CSV, Slides as text, text files as-is. */
  async driveRead(id: string): Promise<DriveFile & { content: string }> {
    const base = DRIVE + '/files/' + encodeURIComponent(id);
    const meta = await this.call<{ id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }>(base, { query: { fields: 'id,name,mimeType,modifiedTime,webViewLink' } });
    const f = meta.data;
    const exportAs: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
    };
    let content: string;
    if (exportAs[f.mimeType]) {
      content = (await this.call<string>(base + '/export', { query: { mimeType: exportAs[f.mimeType] }, text: true })).data;
    } else if (/^text\/|json|xml|csv|markdown/.test(f.mimeType)) {
      content = (await this.call<string>(base, { query: { alt: 'media' }, text: true })).data;
    } else {
      content = '(binary file of type ' + f.mimeType + '; open it at the url instead)';
    }
    return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, url: f.webViewLink ?? '', content: clip(content) };
  }

  /** Poll API (P5) seed for `pollDrive`. */
  async seedDriveChanges(): Promise<string> {
    return (await this.call<{ startPageToken: string }>(DRIVE + '/changes/startPageToken')).data.startPageToken;
  }

  /** Poll API (P5): files changed since `cursor` (a Drive page token). */
  async pollDrive(o: { cursor: string }): Promise<PollResult<{ fileId: string; removed: boolean; name: string; time: string }>> {
    const items: Array<{ fileId: string; removed: boolean; name: string; time: string }> = [];
    let token = o.cursor;
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ changes?: Array<{ fileId: string; removed?: boolean; time: string; file?: { name: string } }>; nextPageToken?: string; newStartPageToken?: string }>(
        DRIVE + '/changes', { query: { pageToken: token, fields: 'changes(fileId,removed,time,file(name)),nextPageToken,newStartPageToken' } },
      );
      for (const c of r.data.changes ?? []) items.push({ fileId: c.fileId, removed: !!c.removed, name: c.file?.name ?? '', time: c.time });
      if (r.data.newStartPageToken) return { items, cursor: r.data.newStartPageToken, notModified: items.length === 0, resync: false };
      if (!r.data.nextPageToken) break;
      token = r.data.nextPageToken;
    }
    return { items, cursor: token, notModified: false, resync: false };
  }
}
