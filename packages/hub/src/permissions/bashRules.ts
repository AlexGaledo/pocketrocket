export type BashVerdict = { verdict: 'allow' | 'ask'; danger: boolean; reason: string };

const ALLOW_PREFIXES: RegExp[] = [
  /^git (status|diff|log|add|commit|branch|show|stash list|rev-parse|ls-files|remote -v)\b/,
  /^(pnpm|npm|npx|yarn|bun|bunx)\b(?!.*\s-g\b)/,
  /^(node|tsx|ts-node|vitest|jest|python3?|pip3? (install|list|show))\b/,
  /^cargo (build|test|run|check|fmt|clippy)\b/,
  /^(ls|dir|cat|type|head|tail|rg|grep|find|echo|mkdir|pwd|cd|wc|sort|uniq|tree|which|where|env|printenv|date|touch|cp|mv|sed|awk|jq|diff|stat|du)\b/,
  /^curl -s?S?L? "?https?:\/\/[^|;&>]+"?$/,
  /^(Get-ChildItem|Get-Content|Select-String|Test-Path|New-Item|Copy-Item|Move-Item|Write-Output|Get-Location)\b/,
];

const DANGER: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/,
  /Remove-Item\b[^|;&]*-Recurse/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh)\b/i,
  /\bnpm\s+publish\b/i,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777/,
  /\bmkfs\b/,
];

function segments(cmd: string): string[] {
  return cmd
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normPath(p: string): string {
  const s = p.replace(/\//g, '\\').replace(/[\\]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function absolutePathOutside(cmd: string, roots: string[]): string | null {
  const re = /(?:[A-Za-z]:[\\/][^\s"'|;&<>]*|\/(?:home|Users|etc|var|tmp|usr|opt)[^\s"'|;&<>]*|~[\\/][^\s"'|;&<>]*)/g;
  const rs = roots.map(normPath);
  for (const m of cmd.match(re) ?? []) {
    if (m.startsWith('~')) return m;
    const n = normPath(m);
    if (!rs.some((r) => n === r || n.startsWith(r + '\\'))) return m;
  }
  return null;
}

export function classifyBash(cmd: string, allowedRoots: string[] = []): BashVerdict {
  for (const d of DANGER) if (d.test(cmd)) return { verdict: 'ask', danger: true, reason: 'Dangerous pattern: ' + d.source };
  const outside = absolutePathOutside(cmd, allowedRoots);
  if (outside) return { verdict: 'ask', danger: false, reason: 'References path outside workspace: ' + outside };
  const segs = segments(cmd);
  if (!segs.length) return { verdict: 'ask', danger: false, reason: 'Empty command' };
  for (const s of segs) {
    if (!ALLOW_PREFIXES.some((re) => re.test(s))) {
      return { verdict: 'ask', danger: false, reason: 'Not on allowlist: ' + s.slice(0, 60) };
    }
  }
  return { verdict: 'allow', danger: false, reason: 'Allowlisted' };
}
