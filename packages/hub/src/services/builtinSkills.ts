import type { Repos } from '../db/repos.js';
import type { SkillService } from './SkillService.js';

/**
 * Skills that ship with the hub. Seeded into the pool at startup when no skill of that name is there, as an approved,
 * owner-authored skill (SkillService.save), so it is an ordinary pool skill afterwards: the owner can read, edit,
 * attach and detach it in Skills. Never overwritten: an owner's edit stays. Deleting it from the pool brings the
 * shipped text back on the next start, since the dev team template needs it; detach it from a bot instead.
 */
export interface BuiltinSkill { name: string; description: string; markdown: string }

export const PROJECT_MAP_SKILL: BuiltinSkill = {
  name: 'project-map',
  description: "Draw or update the project's map (map.json) when the owner asks for a map, a system map, a roadmap or a change to the map.",
  markdown: `# Project map

Use this when the owner asks you to make, regenerate or change the project's map. The app draws the map from one
file, \`map.json\`, at the top of the project's shared folder (the folder that holds \`current.md\`). You write that
file; the app lays it out. Nothing else draws the map, so if you do not write the file there is no map.

## What to read first

- \`current.md\` in the project folder.
- \`repos.json\` there, if it exists, and the repos it lists that you can read (README, the top-level folders, the
  package or build files). Do not read the whole codebase; a map is an overview.

## Which kind

- \`architecture\`: a system map of a software project. Nodes are the main parts (apps, services, stores, models,
  outside services); edges are "talks to" or "depends on".
- \`roadmap\`: for anything else, or when the owner asks for a roadmap. Nodes are milestones in order, each with a
  \`state\` of \`done\`, \`now\` or \`next\`; edges link each milestone to the next.

If the owner named a kind, use it. Otherwise use \`architecture\` when the project has a repo, else \`roadmap\`.

## The file

Write exactly this shape, as JSON (no comments, no trailing commas):

\`\`\`json
{
  "version": 1,
  "kind": "architecture",
  "generatedBy": "your-handle",
  "generatedAt": "2026-11-20",
  "nodes": [
    { "id": "web", "label": "web app", "tech": "React + Vite", "group": "client" },
    { "id": "hub", "label": "hub", "tech": "Node, SQLite", "group": "core" }
  ],
  "edges": [["web", "hub", "active"]]
}
\`\`\`

- \`generatedBy\`: your own handle. \`generatedAt\`: today's date, YYYY-MM-DD.
- Node \`id\` and \`label\`: 1-40 characters, ids unique. \`tech\`: up to 60 characters. \`group\`: up to 20, best one of
  \`client\`, \`core\`, \`data\`, \`ai\`, \`infra\`. \`state\` only on roadmap nodes.
- Edges: \`[from, to]\` or \`[from, to, "active" | "off"]\`, by node id. \`active\` marks the path being worked on now;
  \`off\` marks something planned or switched off.
- Keep it to 30 nodes or fewer (the app refuses more than 60 nodes or 120 edges, or a file over 64 KB).
- No coordinates, colours or sizes: the app places every node.
- No secrets, keys, tokens, passwords, internal URLs, file paths or personal details. Labels are what the owner reads.
- Only what you found in the files. If something is unclear, leave it out and say so in your reply.

## After writing

Replace the whole file in one write. Then reply in one or two lines: what kind of map, how many nodes, and anything you
left out. If the owner asked for a change, change only that and keep the rest of the file as it was.
`,
};

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [PROJECT_MAP_SKILL];

/** Adds each shipped skill that is not in the pool yet. Returns the names it added. */
export function ensureBuiltinSkills(skills: SkillService, repos: Repos, list: readonly BuiltinSkill[] = BUILTIN_SKILLS): string[] {
  const added: string[] = [];
  for (const s of list) {
    if (repos.getSkillByName(s.name)) continue;
    const body = '---\nname: ' + s.name + '\ndescription: ' + s.description + '\n---\n\n' + s.markdown;
    skills.save(s.name, s.description, body, { source: 'authored' });
    added.push(s.name);
  }
  return added;
}
