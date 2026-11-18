import { describe, expect, it } from 'vitest';
import { WorkflowGraphSchema, linearOrder, type WorkflowGraph } from '@pocketrocket/shared';

const g = (nodes: unknown[], edges: [string, string][]): WorkflowGraph =>
  WorkflowGraphSchema.parse({ nodes, edges: edges.map(([from, to]) => ({ from, to })) });
const T = { id: 't', kind: 'trigger', manual: true };
const A = (id: string) => ({ id, kind: 'agent', botId: 'b1', prompt: 'Summarise {{previous}}' });
const P = { id: 'p', kind: 'approval', title: 'Check the draft' };
const O = { id: 'o', kind: 'output', target: 'room' };

describe('linearOrder (workflows v1)', () => {
  it('orders a straight path from the trigger, whatever order the nodes are listed in', () => {
    const r = linearOrder(g([O, P, A('a'), T], [['t', 'a'], ['a', 'p'], ['p', 'o']]));
    expect(r.ok && r.order.map((n) => n.id)).toEqual(['t', 'a', 'p', 'o']);
  });
  it('accepts and ignores ui positions', () => {
    expect(linearOrder(g([{ ...T, ui: { x: 1, y: 2 } }, A('a')], [['t', 'a']])).ok).toBe(true);
  });
  it.each([
    ['branch', [T, A('a'), A('b')], [['t', 'a'], ['t', 'b']], 'only one next step'],
    ['join', [T, A('a'), A('b')], [['t', 'a'], ['b', 'a']], 'only one step'],
    ['orphan', [T, A('a'), A('b')], [['t', 'a']], 'one line'],
    ['cycle', [T, A('a'), A('b')], [['t', 'a'], ['a', 'b'], ['b', 'a']], 'only one step'],
    ['two triggers', [T, { ...T, id: 't2' }, A('a')], [['t', 'a']], 'exactly one trigger'],
    ['unknown edge', [T, A('a')], [['t', 'zz']], 'does not exist'],
    ['approval first', [T, P, A('a')], [['t', 'p'], ['p', 'a']], 'step before it'],
    ['duplicate id', [T, A('a'), A('a')], [['t', 'a']], 'share the id'],
  ] as const)('refuses a %s with a readable error', (_n, nodes, edges, msg) => {
    const r = linearOrder(g([...nodes], edges.map((e) => [...e] as [string, string])));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
  it('needs exactly one trigger source', () => {
    const r = linearOrder(g([{ ...T, manual: false }, A('a')], [['t', 'a']]));
    expect(!r.ok && r.error).toContain('exactly one of');
  });
});
