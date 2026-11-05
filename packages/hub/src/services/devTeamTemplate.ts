/**
 * The development team a new project can start with. Bump `version` whenever `rules` or `roles` change: each project
 * records the version it was cloned from, so a regression can be traced to the template or to the project's own room.
 *
 * Rules are the owner's hard prohibitions, not preferences: only a prohibition can be failed by a test. Check a change
 * with one real task, with and without it, before cloning from it. See docs/project-folders.md.
 */
export const DEV_TEAM_TEMPLATE = {
  version: 1,
  /** Existing bots to clone. Their general role text carries over; the project details do not exist yet. */
  roles: [
    { source: 'product-engineer', suffix: 'product', coordinator: true },
    { source: 'software-engineer', suffix: 'engineer', coordinator: false },
    { source: 'design-engineer', suffix: 'design', coordinator: false },
    { source: 'devops-engineer', suffix: 'devops', coordinator: false },
    { source: 'quality-engineer', suffix: 'quality', coordinator: false },
  ],
  rules: [
    "Never revert, discard, stash away or overwrite changes you did not make, even to tidy up. If someone else's work is in the way, say so and leave it.",
    'Never commit to or push the default branch. Work on a branch and open a pull request for the owner to review.',
    'Back up before changing anything live, and ask before anything destructive or hard to undo.',
    'Say what you verified and what you did not. "It should work" is not a result.',
  ],
} as const;

const SETUP_HEADING = 'When the owner mentions you to create an agent';

/** The role text for a clone: the source's general role, without its instructions for creating other agents. */
export function cloneDescription(sourceDescription: string, projectName: string, dir: string): string {
  const at = sourceDescription.indexOf(SETUP_HEADING);
  const role = (at >= 0 ? sourceDescription.slice(0, at) : sourceDescription).trim();
  return [
    role,
    'You work on the project ' + projectName + '. Its shared folder is ' + dir + ': read current.md there first, and keep it true when facts change.',
    'Rules:\n' + DEV_TEAM_TEMPLATE.rules.map((r) => '- ' + r).join('\n'),
  ].join('\n\n');
}
