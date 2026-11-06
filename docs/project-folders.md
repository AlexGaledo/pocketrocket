# Project folders, room folders and team templates

A project is a folder under `data/projects/<slug>/`, outside the workspace every bot shares, plus a list of the bots that may work in it. The owner manages that list in Settings, Projects. No bot tool can change it.

```text
data/projects/wika/
  current.md     what is true now, read first
  archive/       outdated material, left out of search by default
  imports/       what came from Claude, one file per item
```

## Room folders

Every chat has one file folder (`rooms/roomFiles.ts`):

- A chat linked to a project (its team chat) uses the project's folder.
- Any other group chat uses `data/rooms/<roomId>/`, made the first time it is needed.
- A direct chat uses the bot's `files/` subfolder (`data/bots/<id>/files/`), so its memory, identity and notes stay out of view.

The owner browses these in the Files panel through `/api/rooms/:id/files` (hub token only; paired phones are refused). Every change there sends a `files.changed` event and writes an audit row.

## Access

- A bot can use only the folder of the chat it is replying in. That folder is a working root for the turn (no approval card), and the system prompt names it.
- A project's folder also needs the bot to be on the project. Adding a bot to the project's chat does not open the folder by itself.
- Every other project's folder and every other chat's folder under `data/rooms/` is refused, including with approvals bypassed, by a check on Claude tool calls (`projectGuard.ts`). This holds for a member too: asked about a project from a direct chat or another room, a bot cannot open or search that project's folder.
- `search_project_context` searches only the current chat's project.
- **This is a permission rule, not a wall.** Every bot is the same Linux user, so a shell command that hides the path, or reading the database, gets through. Codex and Grok turns do not run the check. Another bot's home (including its `files/`) is only behind the approval card, not this check. Real isolation needs one Linux user per project.

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

Creating a project with a team clones `DEV_TEAM_TEMPLATE` from `services/devTeamTemplate.ts`: a lead, an engineer and a quality engineer with the project's folder, the template's rules and skills, and a group chat. The clones come from the bots @lead-engineer, @software-engineer and @quality-engineer, so a skill attached to one of those reaches later clones, not existing ones. Every clone also gets `safe-shipping`. Add a specialist such as @design-engineer to the chat and the project's members when a project needs one. Project knowledge then builds up in that folder and chat, not in the template. Each project records the template version it came from in the database and in `TEMPLATE.md`, so a regression can be traced.

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
