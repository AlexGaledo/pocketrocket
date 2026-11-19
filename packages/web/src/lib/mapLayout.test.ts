import { describe, expect, it } from 'vitest';
import type { ProjectMap } from '@pocketrocket/shared';
import { edgePath, fitView, generateMessage, layoutMap, promptMessage } from './mapLayout';

const arch: ProjectMap = {
  version: 1, kind: 'architecture', generatedBy: 'leadeng', generatedAt: '2026-11-20',
  nodes: [
    { id: 'hub', label: 'hub', tech: 'Node', group: 'core' },
    { id: 'web', label: 'web app', tech: 'React', group: 'client' },
    { id: 'db', label: 'sqlite', group: 'data' },
    { id: 'ws', label: 'ws', group: 'core' },
    { id: 'tun', label: 'tunnel', group: 'edge' },
  ],
  edges: [['web', 'hub', 'active'], ['hub', 'db'], ['ws', 'hub'], ['hub', 'tun', 'off']],
};

describe('layoutMap', () => {
  it('gives the same positions for the same map', () => {
    expect(layoutMap(arch)).toEqual(layoutMap(structuredClone(arch)));
  });

  it('puts known groups first in their usual order, then other groups, the busiest box in the middle', () => {
    const l = layoutMap(arch);
    expect(l.groups.map((g) => g.name)).toEqual(['client', 'core', 'data', 'edge']);
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect([x('web'), x('hub'), x('db'), x('tun')]).toEqual([...new Set([x('web'), x('hub'), x('db'), x('tun')])].sort((a, b) => a - b));
    const core = l.nodes.filter((n) => n.group === 'core');
    // hub has 4 links, ws 1: hub takes the centre slot of the column.
    expect(core[0].id).toBe('hub');
    expect(Math.abs(core[0].y - l.groups[1].y)).toBeLessThan(Math.abs(core[1].y - l.groups[1].y) + 200);
  });

  it('keeps the edge states the file gives', () => {
    expect(layoutMap(arch).edges.map((e) => e.tone)).toEqual(['active', 'plain', 'plain', 'off']);
  });

  it('draws a roadmap left to right, with the step into now live and steps into next still to come', () => {
    const road: ProjectMap = { ...arch, kind: 'roadmap', nodes: [{ id: 'a', label: 'a', state: 'done' }, { id: 'b', label: 'b', state: 'now' }, { id: 'c', label: 'c', state: 'next' }], edges: [['a', 'b'], ['b', 'c']] };
    const l = layoutMap(road);
    expect(l.nodes.map((n) => n.x)).toEqual([0, 200, 400]);
    expect(l.edges.map((e) => e.tone)).toEqual(['active', 'off']);
    expect(l.groups).toEqual([]);
  });

  it('gives a map with no groups no "other" heading', () => {
    const l = layoutMap({ ...arch, nodes: arch.nodes.map(({ group: _g, ...n }) => n) });
    expect(l.groups).toEqual([]);
  });

  it('handles an empty map', () => {
    expect(layoutMap({ ...arch, nodes: [], edges: [] }).bounds).toEqual({ x0: 0, x1: 0, y0: 0, y1: 0 });
  });
});

describe('edgePath and fitView', () => {
  it('leaves from the facing side', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 300, y: 0 })).toMatch(/^M84 0C/);
    expect(edgePath({ x: 0, y: 0 }, { x: 0, y: 200 })).toMatch(/^M0 28C/);
  });

  it('fits without zooming past 100%', () => {
    expect(fitView({ x0: 0, y0: 0, x1: 100, y1: 50 }, 1000, 800).s).toBe(1);
    expect(fitView({ x0: 0, y0: 0, x1: 4000, y1: 50 }, 1000, 800).s).toBe(0.35);
  });
});

describe('messages', () => {
  it('asks for a map in plain words', () => {
    expect(generateMessage('leadeng', 'architecture')).toBe("@leadeng Please draw this project's system map (map.json) with the project-map skill.");
    expect(generateMessage('leadeng', 'roadmap', true)).toBe("@leadeng Please redraw this project's roadmap (map.json) with the project-map skill.");
  });

  it('names the picked boxes after the prompt', () => {
    expect(promptMessage('leadeng', '  split the hub  ', [])).toBe('@leadeng split the hub');
    expect(promptMessage('leadeng', 'split it', ['hub', 'ws'])).toBe('@leadeng split it (map: hub, ws)');
  });
});
