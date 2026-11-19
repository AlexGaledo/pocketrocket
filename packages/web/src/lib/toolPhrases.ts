/**
 * Plain words for tool calls, so raw identifiers such as `request_takeover` stay out of the sidebar and the
 * chat's tool chips. Each entry is [finished, in progress]. The expanded chip detail still shows the real name.
 */
type Phrase = readonly [done: string, now: string];

const BROWSER: Record<string, Phrase> = {
  navigate: ['Opened page', 'Opening page'],
  navigate_back: ['Went back', 'Going back'],
  snapshot: ['Read page', 'Reading page'],
  take_screenshot: ['Took screenshot', 'Taking screenshot'],
  click: ['Clicked', 'Clicking'],
  hover: ['Hovered', 'Hovering'],
  type: ['Typed', 'Typing'],
  fill_form: ['Filled form', 'Filling form'],
  select_option: ['Chose option', 'Choosing option'],
  press_key: ['Pressed key', 'Pressing key'],
  wait_for: ['Waited', 'Waiting'],
  tabs: ['Switched tab', 'Switching tab'],
};

const DESKTOP: Record<string, Phrase> = {
  click: ['Clicked on screen', 'Clicking on screen'],
  key: ['Pressed key', 'Pressing key'],
  launch: ['Opened app', 'Opening app'],
  screenshot: ['Took screenshot', 'Taking screenshot'],
  scroll: ['Scrolled', 'Scrolling'],
  type: ['Typed', 'Typing'],
};

const APP: Record<string, Phrase> = {
  request_takeover: ['Asked you to step in', 'Asking you to step in'],
  request_approval: ['Asked for approval', 'Asking for approval'],
  request_form: ['Asked you a few questions', 'Asking you a few questions'],
  handoff: ['Passed work', 'Passing work'],
  use_stronger_model: ['Moved to a stronger model', 'Moving to a stronger model'],
  propose_routing_change: ['Proposed a routing rule', 'Proposing a routing rule'],
  send_message: ['Sent message', 'Sending message'],
  update_memory: ['Updated memory', 'Updating memory'],
  read_memory: ['Read memory', 'Reading memory'],
  save_skill: ['Saved skill', 'Saving skill'],
  list_bots: ['Listed bots', 'Listing bots'],
  create_bot: ['Created bot', 'Creating bot'],
  update_bot: ['Updated bot', 'Updating bot'],
  delete_bot: ['Deleted bot', 'Deleting bot'],
  read_room: ['Read chat', 'Reading chat'],
  list_rooms: ['Listed group chats', 'Listing group chats'],
  create_room: ['Created group chat', 'Creating group chat'],
  delete_room: ['Deleted group chat', 'Deleting group chat'],
  add_to_room: ['Added bot to group chat', 'Adding bot to group chat'],
  remove_from_room: ['Removed bot from group chat', 'Removing bot from group chat'],
  search_notes: ['Searched notes', 'Searching notes'],
  write_note: ['Wrote note', 'Writing note'],
  list_routines: ['Listed schedules', 'Listing schedules'],
  create_routine: ['Created schedule', 'Creating schedule'],
  update_routine: ['Updated schedule', 'Updating schedule'],
  delete_routine: ['Deleted schedule', 'Deleting schedule'],
};

const BUILTIN: Record<string, Phrase> = {
  Read: ['Read file', 'Reading'],
  Write: ['Wrote file', 'Writing'],
  Edit: ['Edited file', 'Editing'],
  MultiEdit: ['Edited file', 'Editing'],
  NotebookEdit: ['Edited notebook', 'Editing'],
  Bash: ['Ran command', 'Running a command'],
  Glob: ['Found files', 'Finding files'],
  Grep: ['Searched files', 'Searching files'],
  WebSearch: ['Searched web', 'Searching the web'],
  WebFetch: ['Fetched page', 'Fetching a page'],
  ToolSearch: ['Loaded tools', 'Loading tools'],
  Skill: ['Used a skill', 'Using a skill'],
};

/** An unmapped name, minus its `mcp__server__` prefix and underscores: "gmail_search" reads "Gmail search". */
function humanize(name: string): string {
  const words = (name.split('__').pop() ?? name).replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toolPhrase(name: string, tense: 'done' | 'now' = 'done'): string {
  let phrase: Phrase | undefined;
  let fallback: Phrase | undefined;
  if (name.startsWith('mcp__pocketrocket__desktop_')) {
    phrase = DESKTOP[name.slice('mcp__pocketrocket__desktop_'.length)];
    fallback = ['Used screen', 'Using screen'];
  } else if (name.startsWith('mcp__browser__')) {
    phrase = BROWSER[name.replace('mcp__browser__browser_', '')];
    fallback = ['Used browser', 'Using browser'];
  } else if (name.startsWith('mcp__pocketrocket__')) {
    phrase = APP[name.slice('mcp__pocketrocket__'.length)];
  } else {
    phrase = BUILTIN[name];
  }
  const chosen = phrase ?? fallback;
  return chosen ? chosen[tense === 'done' ? 0 : 1] : humanize(name);
}

/** The in-progress word of each phrase as a plain verb, for "Wants to …". Listed rather than derived: English drops and doubles letters. */
const BASE: Record<string, string> = {
  Opening: 'open', Going: 'go', Reading: 'read', Taking: 'take', Clicking: 'click', Hovering: 'hover', Typing: 'type',
  Filling: 'fill', Choosing: 'choose', Pressing: 'press', Waiting: 'wait', Switching: 'switch', Scrolling: 'scroll',
  Using: 'use', Asking: 'ask', Passing: 'pass', Moving: 'move', Proposing: 'propose', Sending: 'send', Updating: 'update',
  Saving: 'save', Listing: 'list', Creating: 'create', Deleting: 'delete', Adding: 'add', Removing: 'remove',
  Searching: 'search', Writing: 'write', Editing: 'edit', Running: 'run', Finding: 'find', Fetching: 'fetch', Loading: 'load',
};

/** File tools whose in-progress phrase has no object ("Editing"); asking for one names it. */
const ASK_BUILTIN: Record<string, string> = {
  Read: 'read a file', Write: 'write a file', Edit: 'edit a file', MultiEdit: 'edit a file', NotebookEdit: 'edit a notebook',
};

/**
 * What a bot asks to do, lower case, to follow "Wants to": Bash reads "run a command", an unmapped tool
 * "use gmail search".
 */
export function toolAsk(name: string): string {
  if (ASK_BUILTIN[name]) return ASK_BUILTIN[name];
  const now = toolPhrase(name, 'now');
  const [first, ...rest] = now.split(' ');
  const verb = BASE[first];
  return verb ? [verb, ...rest].join(' ') : 'use ' + now.toLowerCase();
}
