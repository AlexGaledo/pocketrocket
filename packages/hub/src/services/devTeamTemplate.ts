/**
 * The development team a new project can start with. Bump `version` whenever `rules` or `roles` change: each project
 * records the version it was cloned from, so a regression can be traced to the template or to the project's own room.
 *
 * Rules are the owner's hard prohibitions, not preferences: only a prohibition can be failed by a test. Check a change
 * with one real task, with and without it, before cloning from it. See docs/project-folders.md.
 */
export const DEV_TEAM_TEMPLATE = {
  version: 2,
  /**
   * Existing bots to clone. Their general role text and skills carry over; the project details do not exist yet.
   * Three roles on purpose: one to plan, one to build, and one to check the work independently. Add a specialist such
   * as @design-engineer to the project's chat when a project needs one.
   */
  roles: [
    { source: 'lead-engineer', suffix: 'lead', coordinator: true },
    { source: 'software-engineer', suffix: 'engineer', coordinator: false },
    { source: 'quality-engineer', suffix: 'quality', coordinator: false },
  ],
  /** Every clone gets these, whatever its source has. safe-shipping is what turns on the push block (shipGuard.ts). */
  skills: ['safe-shipping'],
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
    'You work on the project ' + projectName + '. Its shared folder is ' + dir + ': read current.md there first, and keep it true when facts change. TEMPLATE.md there says which team template you came from.',
    'Rules:\n' + DEV_TEAM_TEMPLATE.rules.map((r) => '- ' + r).join('\n'),
  ].join('\n\n');
}

/** What a project keeps about the template it was cloned from, so its bots and the owner can see where the rules came from. */
export function templateRecord(projectName: string, today: string, skillsByHandle: Record<string, string[]>): string {
  return [
    '---', 'status: current', 'updated: ' + today, '---', '',
    '# Team template for ' + projectName, '',
    'Cloned from dev team template v' + DEV_TEAM_TEMPLATE.version + ' on ' + today + '. General practice comes from the template; what is true about this project belongs in current.md.', '',
    '## Team', '',
    ...Object.entries(skillsByHandle).map(([handle, skills]) => '- @' + handle + ': ' + (skills.length ? skills.join(', ') : 'no skills')),
    '', '## Rules', '',
    ...DEV_TEAM_TEMPLATE.rules.map((r) => '- ' + r),
    '',
  ].join('\n');
}
