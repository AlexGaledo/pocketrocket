import { z } from 'zod';

/**
 * Project maps (Toki UI spec, B2). A bot with the `project-map` skill writes `map.json` at the top of a project's
 * folder; the web lays the nodes out itself, so the file never carries coordinates. Every string is shown as plain
 * text, never as Markdown, HTML or a link.
 */
export const MAP_FILE = 'map.json';
/** Larger files are refused before they are read. */
export const MAX_MAP_BYTES = 64 * 1024;
export const MAX_MAP_NODES = 60;
export const MAX_MAP_EDGES = 120;
export const MAP_GROUPS = ['client', 'core', 'data', 'ai', 'infra'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const ProjectMapNodeSchema = z.object({
  id: text(40),
  label: text(40),
  tech: z.string().trim().max(60).optional(),
  /** Any short word; the web orders the usual ones ({@link MAP_GROUPS}) first and the rest after them. */
  group: z.string().trim().max(20).optional(),
  /** Roadmap only. */
  state: z.enum(['done', 'now', 'next']).optional(),
});

/** `[from, to]` or `[from, to, state]`, by node id. */
export const ProjectMapEdgeSchema = z.union([
  z.tuple([z.string().max(40), z.string().max(40)]),
  z.tuple([z.string().max(40), z.string().max(40), z.enum(['active', 'off'])]),
]);

export const ProjectMapSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['architecture', 'roadmap']),
    /** The bot's handle, with or without the @. */
    generatedBy: text(40),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-11-20'),
    nodes: z.array(ProjectMapNodeSchema).max(MAX_MAP_NODES),
    edges: z.array(ProjectMapEdgeSchema).max(MAX_MAP_EDGES),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.nodes.forEach((n, i) => {
      if (seen.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: 'duplicate node id "' + n.id + '"' });
      seen.add(n.id);
    });
  });

export type ProjectMapNode = z.output<typeof ProjectMapNodeSchema>;
export type ProjectMapEdge = z.output<typeof ProjectMapEdgeSchema>;
export type ProjectMap = z.output<typeof ProjectMapSchema>;

/**
 * `GET /api/projects/:slug/map`. No file: everything null. A file that is too large, not JSON or not a valid map:
 * `map: null` and `error` naming the first problem, so the web shows the error instead of a partial map. Edges that
 * name a missing node are dropped from `map`, and `droppedEdges` says how many.
 */
export interface ProjectMapReply {
  map: ProjectMap | null;
  error: string | null;
  /** The file's mtime in ms; null when there is no file. */
  mtime: number | null;
  droppedEdges: number;
}

/** Validates parsed JSON as a map and drops edges that point at missing nodes. */
export function checkProjectMap(input: unknown): { map: ProjectMap; droppedEdges: number } | { error: string } {
  const r = ProjectMapSchema.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    return { error: (i.path.length ? i.path.join('.') + ': ' : '') + i.message };
  }
  const ids = new Set(r.data.nodes.map((n) => n.id));
  const edges = r.data.edges.filter((e) => ids.has(e[0]) && ids.has(e[1]));
  return { map: { ...r.data, edges }, droppedEdges: r.data.edges.length - edges.length };
}

/**
 * `GET /api/projects/:slug/overview`, parsed from the project's `current.md` with no AI turn. No file: every field
 * null or empty.
 */
export interface ProjectOverview {
  /** The front matter's `updated:`. */
  updated: string | null;
  /** `- [x]` / `- [ ]` boxes anywhere in the file; null when there are none. `stage`: the nearest `## ` heading above the first unticked box (null when all are ticked). */
  plan: { done: number; total: number; stage: string | null } | null;
  /** The first bullet under a heading starting with "Next". */
  next: string | null;
  /** The last 3 bullets under a heading starting with "Done" or "Shipped". */
  done: string[];
  /** Bullets under "Waiting on me", "Waiting on owner" or "Waiting on you". */
  waiting: string[];
}
