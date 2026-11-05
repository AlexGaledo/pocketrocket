# Importing Claude project context

Three ways to bring a Claude project's context to PocketRocket, side by side so we can keep what works. All of them end in the same place: files in a project's folder, for that project's members. See `docs/project-folders.md`. Create the project first with `node scripts/context-import.mjs project create "My project"`, and pass its name or slug to `--project`.

| Way | Reviewed | Stays current | Needs |
|---|---|---|---|
| Drop folder | On the PC, before upload | Re-run after a change | Copying files by hand |
| Claude export | On the PC, before upload | One-time snapshot | Requesting an export, unzipping it |
| Claude connector | On the hub, before it reaches the folder | Whenever you ask Claude to save | A public URL for one hub path |

**What gets cleaned.** Credentials, emails, Philippine phone numbers and government ID numbers, on the PC and again on the hub. Names, money amounts and the substance of a conversation stay, so leave out whole chats with `--exclude`.

**What this does not protect against.** Every bot runs as the same Linux user, so project membership is a rule on tool calls, not a wall. A password with no label cannot be detected. Upload only what you would accept any bot reading.

## Setup

```sh
ssh -N -L 7788:127.0.0.1:7788 crm-agency                # leave running
export POCKETROCKET_TOKEN=...                           # data/hub-token on the server
```

## 1. Drop folder

Save the project's instructions and knowledge files as `.md` or `.txt` in one folder. Other file types are listed and skipped.

```sh
node scripts/context-import.mjs drop ./my-project --project "My project"          # preview
node scripts/context-import.mjs drop ./my-project --project "My project" --upload
node scripts/context-import.mjs project members my-project baseline
```

## 2. Claude export

Claude Settings, Privacy, Export data. It arrives as a list of links to separate zips, which need your signed-in browser. Unzip `projects`, `memories` and `conversations` into one folder. The format is not documented, so `--list` first shows what it holds. Chats carry no link to their project, so `--match` picks them by name. Your general Claude memory is left out; only a project's own memory comes across.

```sh
node scripts/context-import.mjs export ./claude-export --list
node scripts/context-import.mjs export ./claude-export --project "My project" --match "my project"
node scripts/context-import.mjs export ./claude-export --project "My project" --match "my project" --exclude "agreement,tax,board"
node scripts/context-import.mjs export ./claude-export --project "My project" --match "my project" --exclude "agreement,tax,board" --upload
```

## 3. Claude connector

The endpoint has one tool, `save_project_context`. It adds to a review queue and returns nothing from the hub, and the queue is capped at 200 items. The secret in the URL can be replaced at any time, and only its hash is stored.

On the server, route only that path, and pass a loopback `Host` so the hub's Host check holds without allowing a public name for the rest of the hub:

```caddy
context.example.com {
	handle /mcp/context/* {
		reverse_proxy 127.0.0.1:7788 {
			header_up Host 127.0.0.1:7788
			header_up -Origin
		}
	}
	handle {
		respond 404
	}
	log {
		output discard
	}
}
```

Logging is off for this site because the secret is in the URL path.

```sh
node scripts/context-import.mjs connector on      # prints the path
```

In Claude: Settings, Connectors, Add custom connector, and paste `https://context.example.com<path>`. In the project's chat, ask: "Save this project's instructions and what its knowledge files say to PocketRocket."

```sh
node scripts/context-import.mjs pending
node scripts/context-import.mjs show <id>
node scripts/context-import.mjs approve <id>      # or: reject <id>
node scripts/context-import.mjs connector off     # when finished
```
