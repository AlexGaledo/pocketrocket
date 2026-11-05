# Project folders and team templates

A project is a folder under `data/projects/<slug>/`, outside the workspace every bot shares, plus a list of the bots that may work in it. The owner manages that list in Settings, Projects. No bot tool can change it.

```text
data/projects/wika/
  current.md     what is true now, read first
  archive/       outdated material, left out of search by default
  imports/       what came from Claude, one file per item
```

## Access

- A member can read and write the folder, and gets `search_project_context`.
- Anyone else is refused, including with approvals bypassed, by a check on Claude tool calls (`projectGuard.ts`).
- **This is a permission rule, not a wall.** Every bot is the same Linux user, so a shell command that hides the path, or reading the database, gets through. Codex and Grok turns do not run the check. Real isolation needs one Linux user per project.

## Keeping context true

Embeddings do not tell old from new, so this is handled by plain rules. Files can start with:

```yaml
---
status: current        # or archived, superseded
updated: 2026-10-22
review_by: 2026-12-05
---
```

- Search skips `archive/`, `archived` and `superseded` unless asked, puts `current.md` first, and shows each hit's date.
- `GET /api/projects/:slug/lint` flags expired, undated, duplicate and near-empty files. It changes nothing.
- Searches that find nothing are logged, and lint shows them. If real lookups keep failing because of rewording or Taglish, that is the evidence for testing embeddings. Test them with those same questions.

## Importing from Claude

See `docs/context-import.md`. Imports become files under `imports/`, with their dates.

## Development team template

Creating a project with a team clones `DEV_TEAM_TEMPLATE` from `services/devTeamTemplate.ts`: five bots with the project's folder and the template's rules, and a group chat. Project knowledge then builds up in that folder and chat, not in the template. Each project records the template version it came from, so a regression can be traced.

### Blocking pushes to the default branch

Attach the `safe-shipping` skill to a bot and its Claude turns cannot push to the default branch or merge a pull request (`permissions/shipGuard.ts`). Written rules alone failed this in testing. It reads the command text, so it stops ordinary use, not a bot set on getting around it.

### Testing a template or skill

A skill or template change only counts when it changes behaviour on a task that could fail:

1. Pick a rule that can be broken. Prohibitions work; preferences usually cannot fail.
2. Build a real task with a trap for that rule, and a pass or fail you can check by machine, such as git state.
3. Run the same task on temporary bots, with and without the change, at the same model. At least 3 runs each.
4. A case passes only if all its runs pass. Don't quote a percentage from a small set: 3 runs catch failures, they don't measure a gain.
5. Read the failures yourself. Delete the temporary bots.

`claude plugin eval` cannot test hub bots, since it runs outside the hub without their description, memory or hub tools.
