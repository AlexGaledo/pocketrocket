import { ApiClient, clip, type PollResult } from './base.js';
import { IntegrationError } from './http.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface TeamsChat { id: string; topic: string; type: string; lastMessage: string; lastFrom: string; lastAt: string | null; url: string }
export interface TeamsMessage { id: string; from: string; text: string; createdAt: string }

type RawChat = {
  id: string; topic?: string | null; chatType: string; webUrl?: string;
  lastMessagePreview?: { createdDateTime: string; body?: { content?: string }; from?: { user?: { displayName?: string } } } | null;
};
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const toChat = (c: RawChat): TeamsChat => ({
  id: c.id, topic: c.topic ?? '', type: c.chatType, url: c.webUrl ?? '',
  lastMessage: strip(c.lastMessagePreview?.body?.content ?? '').slice(0, 300),
  lastFrom: c.lastMessagePreview?.from?.user?.displayName ?? '', lastAt: c.lastMessagePreview?.createdDateTime ?? null,
});
const chatId = (v: string) => {
  if (!/^[A-Za-z0-9:@._-]{4,200}$/.test(v)) throw new IntegrationError('Bad Teams chat id "' + v + '"', 400);
  return encodeURIComponent(v);
};

/** Microsoft Graph, delegated: the signed-in user's 1:1 and group chats. Channel messages need admin consent and are not covered. */
export class TeamsClient extends ApiClient {
  async whoami(): Promise<{ name: string; email: string }> {
    const r = await this.call<{ displayName?: string; mail?: string | null; userPrincipalName?: string }>(GRAPH + '/me');
    return { name: r.data.displayName ?? '', email: r.data.mail || r.data.userPrincipalName || '' };
  }

  async listChats(limit = 20): Promise<TeamsChat[]> {
    const r = await this.call<{ value: RawChat[] }>(GRAPH + '/me/chats', {
      query: { $expand: 'lastMessagePreview', $orderby: 'lastMessagePreview/createdDateTime desc', $top: Math.min(limit, 50) },
    });
    return r.data.value.map(toChat);
  }

  async readChat(id: string, limit = 30): Promise<TeamsMessage[]> {
    const r = await this.call<{ value: Array<{ id: string; createdDateTime: string; from?: { user?: { displayName?: string } } | null; body?: { content?: string }; messageType?: string }> }>(
      GRAPH + '/chats/' + chatId(id) + '/messages', { query: { $top: Math.min(limit, 50) } },
    );
    return r.data.value
      .filter((m) => !m.messageType || m.messageType === 'message')
      .map((m) => ({ id: m.id, from: m.from?.user?.displayName ?? '', text: clip(strip(m.body?.content ?? ''), 4_000), createdAt: m.createdDateTime }));
  }

  async sendChat(id: string, text: string): Promise<{ id: string }> {
    const r = await this.call<{ id: string }>(GRAPH + '/chats/' + chatId(id) + '/messages', { method: 'POST', json: { body: { contentType: 'text', content: text } } });
    return { id: r.data.id };
  }

  /**
   * Poll API (P5): chats whose last message is newer than `cursor` (an ISO timestamp). Delegated chat
   * delta queries do not exist, so this polls `/me/chats` with `lastMessagePreview`, as the research advises.
   */
  async pollChats(o: { cursor?: string | null } = {}): Promise<PollResult<TeamsChat>> {
    const chats = await this.listChats(50);
    const since = o.cursor ? Date.parse(o.cursor) : 0;
    const fresh = chats.filter((c) => c.lastAt && Date.parse(c.lastAt) > since);
    const max = fresh.reduce((m, c) => (c.lastAt && c.lastAt > m ? c.lastAt : m), o.cursor ?? '');
    return { items: fresh, cursor: max || null, notModified: fresh.length === 0, resync: false };
  }
}
