/**
 * Terminal styling helpers — zero dependencies.
 * Visual language matches Claude Code: warm orange accent, dim secondary
 * text, minimal chrome, ✓/✗/! glyphs. Colors disable automatically when
 * output is not a TTY, NO_COLOR is set, or TERM=dumb (FORCE_COLOR wins).
 */
import type { Tier } from '../types.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function supportsColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

export interface Term {
  accent: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  /** Consistent tier coloring: haiku=cyan, sonnet=yellow, opus=magenta */
  tier: (t: Tier | string) => string;
  ok: () => string;
  fail: () => string;
  warn: () => string;
  /** Red message to stderr */
  /** The text `errorLine` prints, as a value — for callers that return output. */
  errorText: (msg: string) => string;
  errorLine: (msg: string) => void;
  /** Box with width computed from visible (ANSI-stripped) content */
  box: (title: string, rows: Array<[string, string]>) => string;
  readonly enabled: boolean;
}

export function createTerm(opts?: { forceColor?: boolean }): Term {
  const enabled = opts?.forceColor ?? supportsColor();

  const wrap = (open: string, close = '\x1b[39m') =>
    enabled ? (s: string) => `\x1b[${open}m${s}${close}` : (s: string) => s;

  // Claude Code's warm coral/orange brand accent (256-color)
  const accent = enabled ? (s: string) => `\x1b[38;5;209m${s}\x1b[39m` : (s: string) => s;
  const red = wrap('31');
  const green = wrap('32');
  const yellow = wrap('33');
  const cyan = wrap('36');
  const magenta = wrap('35');
  const dim = enabled ? (s: string) => `\x1b[2m${s}\x1b[22m` : (s: string) => s;
  const bold = enabled ? (s: string) => `\x1b[1m${s}\x1b[22m` : (s: string) => s;

  const tierColors: Record<string, (s: string) => string> = {
    haiku: cyan,
    sonnet: yellow,
    opus: magenta,
  };
  const tier = (t: Tier | string) => (tierColors[t] ?? ((s: string) => s))(t);

  const box = (title: string, rows: Array<[string, string]>): string => {
    const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));
    const lines = rows.map(
      ([label, value]) => `${dim(label.padEnd(labelWidth))}  ${value}`,
    );
    const contentWidth = Math.max(
      stripAnsi(title).length + 1,
      ...lines.map((l) => stripAnsi(l).length),
    );
    const top = `╭─ ${bold(title)} ${'─'.repeat(contentWidth - stripAnsi(title).length - 1)}╮`;
    const body = lines.map(
      (l) => `│ ${l}${' '.repeat(contentWidth - stripAnsi(l).length)} │`,
    );
    const bottom = `╰${'─'.repeat(contentWidth + 2)}╯`;
    return [top, ...body, bottom].join('\n');
  };

  return {
    accent,
    red,
    green,
    yellow,
    cyan,
    magenta,
    dim,
    bold,
    tier,
    ok: () => green('✓'),
    fail: () => red('✗'),
    warn: () => yellow('!'),
    errorText: (msg: string) => red(`✗ ${msg}`),
    errorLine: (msg: string) => console.error(red(`✗ ${msg}`)),
    box,
    enabled,
  };
}

/** Shared default instance for stdout */
export const term = createTerm();
