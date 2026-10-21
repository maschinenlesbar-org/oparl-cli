// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OparlClient, OparlClientOptions } from "@maschinenlesbar.org/oparl-client/internal/client";
import { OparlError, cutForMessage } from "@maschinenlesbar.org/oparl-client/internal/errors";
import { createLogger, type Logger } from "./log.js";

/**
 * Writing the output to the `-o` file failed (a missing directory, a full disk, EACCES, a
 * file that appeared during the request, …). Logged as an ERROR of `oparl.output`, exit 1.
 */
export class OutputError extends OparlError {}

/** What is at an `-o` path: nothing, a directory, or anything else (a file, a link: a dangling one too). */
export type OutputState = "absent" | "directory" | "exists";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Write the `-o` file (`nodeFiles.write` in `defaultIO`): atomically, and without
   * `overwrite` never over an existing path. A failure throws; an OutputError carries the
   * message as it is shown.
   */
  writeFile(path: string, data: Buffer, overwrite: boolean): void;
  /**
   * What is at an `-o` path, checked before any request (`nodeFiles.state` in `defaultIO`).
   * A test double without it skips that early check; the write still refuses.
   */
  outputState?(path: string): OutputState;
}

/** The message for an existing `-o` path without `--force`. */
export function refuseOverwrite(path: string): string {
  return `Refusing to overwrite existing file "${cutForMessage(path)}"; pass --force to overwrite.`;
}

/** The message for an `-o` path that is a directory, which `--force` can't fix. */
export function isDirectoryMessage(path: string): string {
  return `"${cutForMessage(path)}" is a directory; give a file path to --output.`;
}

/** The real file system for `-o`. */
export const nodeFiles = {
  /** What is at `path`, without following a dangling link into "absent". */
  state(path: string): OutputState {
    try {
      return statSync(path).isDirectory() ? "directory" : "exists";
    } catch {
      // statSync follows a link; a dangling one is still something an exclusive create
      // refuses, so lstat decides between "exists" and "absent".
      try {
        lstatSync(path);
        return "exists";
      } catch {
        return "absent";
      }
    }
  },
  /**
   * Write `data` to `path` atomically: the old file stays as it was until the new one is
   * complete. Without `overwrite` an existing path is refused, checked by an exclusive create
   * that closes the race with a file appearing meanwhile. Throws an OutputError naming the
   * file and the reason (`refuseOverwrite`, `isDirectoryMessage`, `Could not write to …`).
   */
  write(path: string, data: Buffer, overwrite: boolean): void {
    if (nodeFiles.state(path) === "directory") throw new OutputError(isDirectoryMessage(path));
    let claimed = false;
    try {
      // Without overwrite the name is claimed first with an exclusive create, which fails for
      // any existing path (a dangling link too, since it never follows one).
      if (!overwrite) {
        closeSync(openSync(path, "wx"));
        claimed = true;
      }
      replaceFile(overwrite ? throughLinks(path) : path, data);
    } catch (cause) {
      // A write cut short (a full disk, a quota) leaves no file under the new name either, so
      // the next run isn't refused for a file that holds half a result.
      if (claimed) rmSync(path, { force: true });
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST" && !claimed) throw new OutputError(refuseOverwrite(path), { cause });
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new OutputError(`Could not write to "${cutForMessage(path)}": ${reason}`, { cause });
    }
  },
};

/**
 * Replace `target` with `data` atomically: a temporary file beside it, created exclusively,
 * renamed over it. A write cut short (a full disk, a killed process) leaves the old file as it
 * was, never half of the new one. An existing file's mode is kept.
 */
function replaceFile(target: string, data: Buffer): void {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const mode = modeOf(target);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/** The file a path names, through any symlinks, so --force writes where a link points. */
function throughLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: OparlClientOptions): OparlClient;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an unhandled
 * 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| less`, a closed terminal — closes our stdout
 * while we are still writing, and the next write fails with EPIPE (ENOTCONN when stdout
 * is a socket whose peer has gone, as when a Node parent spawns the CLI with piped stdio on
 * macOS). That is ordinary use, so the process exits 0 at once, quietly. Any other stdout
 * error is an ERROR record of `oparl.output` (`Could not write to stdout: <message>`,
 * through `log`, in the run's format) and exits 1. On stderr an EPIPE is ignored, so
 * a failed run keeps its exit code (`2>&1 | true` turned a usage error into 0); any other
 * stderr error exits 1 silently (there is nowhere left to report it). The bin shim
 * installs this once, before `run()`, with a logger for the format argv asks for
 * (`processLogger`).
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => process.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

/** What `stderrAfterStdout` needs of stdout: its backlog, and the events that end one. */
export interface StdoutBacklog {
  readonly writableLength: number;
  on(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/** How often a held record checks whether stdout's backlog is gone (ms). */
const BACKLOG_POLL_MS = 10;

/**
 * A stderr writer that waits for stdout. With both streams on one pipe (`2>&1 |`) and a
 * slow reader, stdout's data is still queued in the process while a record is written
 * to stderr at once, so the record landed inside the JSON (at 64 KiB). Here a text is
 * held while `stdout.writableLength > 0` and written, in order, once the backlog is
 * gone: on stdout's `drain`, `close` or `error`, or at the latest when a short poll sees
 * it empty (`drain` only follows a write that returned false). The poll keeps the
 * process alive until then, so a held record is never lost at exit.
 */
export function stderrAfterStdout(stdout: StdoutBacklog, write: (text: string) => void): (text: string) => void {
  const held: string[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const flush = (): void => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    for (const text of held.splice(0)) write(text);
  };
  let listening = false;
  return (text) => {
    if (held.length === 0 && stdout.writableLength === 0) return write(text);
    held.push(text);
    if (!listening) {
      listening = true;
      for (const event of ["drain", "close", "error"] as const) stdout.on(event, flush);
    }
    poll ??= setInterval(() => {
      if (stdout.writableLength === 0) flush();
    }, BACKLOG_POLL_MS);
  };
}

const stderrLine = stderrAfterStdout(process.stdout, (text) => process.stderr.write(text + "\n"));

/** A short pause for a non-blocking descriptor that is full (EAGAIN), without a busy loop. */
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write all of `data` to `fd`, or throw. `writeSync` may write less than asked (a file-size
 * limit, a full disk): the rest is written in a loop, and the call that cannot write throws
 * (EFBIG, ENOSPC). A descriptor the shell made non-blocking (a pipe through `/dev/fd/N`) answers
 * EAGAIN while the reader is behind: wait a moment and go on.
 */
function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length; ) {
    try {
      at += writeSync(fd, data, at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

/** What `stdoutWriter` needs of stdout. */
interface Stdout {
  write(text: string): unknown;
  emit(event: "error", err: Error): unknown;
  readonly fd?: number;
}

/**
 * A writer for stdout that never drops a byte silently. When stdout is a regular file
 * (`> out.json`), Node's stream wrote it with one `writeSync` and ignored a short count, so a
 * file-size limit or a full disk cut the output short with exit 0 and nothing on stderr. Here
 * the text is written with `writeAll`, and a failure (EFBIG, ENOSPC) is emitted as stdout's
 * `error`, which `handleOutputErrors` turns into an ERROR record of `oparl.output` and
 * exit 1. A pipe, a socket or a terminal goes through the stream as before (EPIPE stays quiet).
 */
export function stdoutWriter(stdout: Stdout = process.stdout, write: (fd: number, data: Buffer) => void = writeAll): (text: string) => void {
  let toFile: boolean | undefined;
  return (text) => {
    toFile ??= stdout.fd !== undefined && isRegularFile(stdout.fd);
    if (!toFile) {
      stdout.write(text);
      return;
    }
    try {
      write(stdout.fd as number, Buffer.from(text, "utf8"));
    } catch (err) {
      stdout.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  };
}

function isRegularFile(fd: number): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

const stdoutText = stdoutWriter();

export const defaultIO: CliIO = {
  out: (text) => stdoutText(text + "\n"),
  // A record never lands inside the data when both streams share a pipe.
  err: stderrLine,
  writeFile: (path, data, overwrite) => nodeFiles.write(path, data, overwrite),
  outputState: (path) => nodeFiles.state(path),
};
