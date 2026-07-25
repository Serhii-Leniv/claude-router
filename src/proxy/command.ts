import { term } from './term.js';

/**
 * What a CLI command produces: text to show and a process exit code.
 *
 * Commands used to decide and print in the same breath — every `cmd*` was
 * `void` and reached `console.log`/`process.exit` directly, so none of them was
 * reachable from a test. The decisions they encode are not incidental: which of
 * two network-exposure warnings applies, which args a restart inherits, whether
 * `doctor` exits 0 or 3. Returning them as a value is what makes those
 * assertable; `renderResult` is the one place that writes.
 */
export interface OutputLine {
  text: string;
  /** Write to stderr instead of stdout (warnings, failures). */
  stderr?: boolean;
  /**
   * Write verbatim, with no trailing newline added — for content that already
   * carries its own line breaks, like a log tail.
   */
  raw?: boolean;
}

export interface CommandResult {
  lines: OutputLine[];
  /** Process exit code. 0 means success; `doctor` returns its failure count. */
  exitCode: number;
}

export const out = (text: string): OutputLine => ({ text });
export const err = (text: string): OutputLine => ({ text, stderr: true });
export const raw = (text: string): OutputLine => ({ text, raw: true });

/** A failure line in the same shape `term.errorLine` prints. */
export const failLine = (msg: string): OutputLine => err(term.errorText(msg));

/** A warning line in the same shape the commands printed inline. */
export const warnLine = (msg: string): OutputLine => err(`${term.warn()} ${msg}`);

export function ok(lines: OutputLine[] = []): CommandResult {
  return { lines, exitCode: 0 };
}

export function failed(lines: OutputLine[], exitCode = 1): CommandResult {
  return { lines, exitCode };
}

/**
 * The only place a command's output reaches the terminal.
 *
 * Sets `process.exitCode` rather than calling `process.exit`: a command that
 * leaves work running (the foreground server, `logs -f`) must keep the process
 * alive, and one that does not exits on its own with the code we set.
 */
export function renderResult(result: CommandResult): void {
  for (const line of result.lines) {
    if (line.raw) process.stdout.write(line.text);
    else if (line.stderr) console.error(line.text);
    else console.log(line.text);
  }
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
