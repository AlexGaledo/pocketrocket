/**
 * How long the Claude Code CLI keeps session transcripts (`~/.claude/projects/**.jsonl`). Its default is 30
 * days: at startup the CLI deletes older transcripts, and a bot whose session file is gone can no longer
 * resume, so it forgets the conversation it was in. Ten years is "keep them"; the hub prunes nothing itself.
 *
 * Bot turns get it as flag settings (providers/claude.ts), which load although `settingSources` is empty. The
 * hub never edits ~/.claude/settings.json: on a desktop install that is the owner's own Claude Code config. The
 * server's service user gets it from deploy/setup-vps.sh.
 */
export const SESSION_RETENTION_DAYS = 3650;
