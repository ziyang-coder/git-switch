#!/usr/bin/env node
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { listCommand } from './commands/list.ts';
import { addCommand } from './commands/add.ts';
import { versionReport } from './core/version.ts';
import { diffCommand } from './commands/diff.ts';
import { applyCommand } from './commands/apply.ts';
import { initCommand } from './commands/init.ts';
import { doctorCommand } from './commands/doctor.ts';
import { guiCommand } from './commands/gui.ts';
import { keyCommand } from './commands/key.ts';
import { snapshotCommand } from './commands/snapshot.ts';
import { createLogger } from './util/log.ts';
import { resolveLanguage, setLanguage, t } from './core/i18n.ts';
import { ModelError } from './core/model.ts';
import { ProfilesMissingError } from './core/profiles.ts';
import { BlockError } from './core/managed-block.ts';


/** The help screen is built per language so `--lang` can change it. */
function usageText(): string {
  return `${t('usage.title')}

${t('usage.heading')}

${t('usage.commands')}
  init [--root <dir>]   ${t('init.usage')}
        [--force]       ${t('init.force')}
        [--offline]     ${t('init.offline')}
  list                  ${t('list_rules_hint')}
  add [dir] --identity <name>   ${t('add.usage')}
        [--comment <text>]      ${t('add.commentFlag')}
        [--force]               ${t('add.forceFlag')}
        [--dry-run]             ${t('apply_dryrun_hint')}
  diff                  ${t('diff_hint')}
  apply [--dry-run]     ${t('apply_hint')}
        [--force]       ${t('apply_force_hint')}
  doctor [--online]     ${t('doctor_hint')}
  gui [--port N]        ${t('gui_hint')}
        [--no-open]     ${t('gui_noopen_hint')}
        [--idle-timeout <min>]  ${t('gui_idle_hint')}
  key list              ${t('key_list_hint')}
  key gen <name>        ${t('key_gen_hint')}
  key copy <name>       ${t('key_copy_hint')}
  key restore <snapshot> [--force]
                        ${t('key_restore_hint')}
  snapshot export <file> [--with-keys] [--force]
                        ${t('snapshot_export_hint')}
  snapshot import <file> [--remap OLD=NEW] [--force]
                        ${t('snapshot_import_hint')}
  help                  ${t('usage.help')}
  version               ${t('usage.version')}

${t('usage.options')}
  --home <dir>          ${t('option_home')}
  --lang <en|zh-CN>     ${t('usage.lang')}
  --json                ${t('option_json')}
  --no-color            ${t('option_nocolor')}

${t('usage.exitCodes')}`;
}

interface ParsedArgs {
  command: string | undefined;
  /** positional arguments after the command: `key gen NAME` -> ['gen', 'NAME'] */
  args: string[];
  flags: Set<string>;
  /** multi-value: `--remap a=b --remap c=d` keeps both */
  values: Map<string, string[]>;
}

/** Last value wins; use this for single-valued flags. */
function valueOf(parsed: ParsedArgs, name: string): string | undefined {
  const list = parsed.values.get(name);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/** Every occurrence, in order: required for flags like `--remap`. */
function allOf(parsed: ParsedArgs, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

const VALUE_FLAGS = ['--identity', '--home', '--port', '--idle-timeout', '--root', '--comment', '--remap', '--lang'];

/**
 * Decide whether to emit ANSI colour.
 *
 * Colour only helps an interactive terminal, so it is off when stdout is not a
 * TTY (pipes, redirects, test capture). `NO_COLOR` (any non-empty value) and
 * `--no-color` both force it off, per https://no-color.org.
 */
function shouldUseColor(args: ParsedArgs, stream: NodeJS.WriteStream): boolean {
  if (args.flags.has('no-color')) return false;
  if (args.flags.has('json')) return false;
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return stream.isTTY === true;
}

/**
 * Parse a numeric option, returning a UsageError instead of NaN.
 * A non-integer or out-of-range value is a command-line mistake, not a crash.
 */
function parseIntegerFlag(
  args: ParsedArgs,
  name: string,
  bounds: { min: number; max?: number },
): number | undefined | UsageError {
  const raw = valueOf(args, name);
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw.trim())) {
    return new UsageError(`--${name} expects a whole number, got "${raw}"`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < bounds.min || (bounds.max !== undefined && value > bounds.max)) {
    const range = bounds.max === undefined ? `at least ${bounds.min}` : `between ${bounds.min} and ${bounds.max}`;
    return new UsageError(`--${name} must be ${range}, got ${value}`);
  }
  return value;
}

/** `--lang` as written on the command line, read before full parsing succeeds. */function readRawLang(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--lang') return argv[i + 1];
    const eq = arg.indexOf('=');
    if (eq !== -1 && arg.slice(0, eq) === '--lang') return arg.slice(eq + 1);
  }
  return undefined;
}

/**
 * A bad command line. Reported as a one-line usage error with exit code 2,
 * never as a stack trace.
 */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Every flag the CLI understands.
 *
 * An unchecked `--xxx` used to be collected as a flag and ignored, so a typo like
 * `--dryrun` (one hyphen short of `--dry-run`) *applied* the change the user meant
 * to preview. Unknown flags are now a usage error.
 */
const KNOWN_FLAGS = new Set([
  'json',
  'no-color',
  'force',
  'dry-run',
  'offline',
  'online',
  'no-open',
  'short',
  'help',
  'with-keys',
]);

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positionals: string[] = [];

  const record = (name: string, value: string) => {
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // `--version` and `--help` are the conventional spellings of the `version`
    // and `help` commands; without this they parsed as flags, leaving no command
    // and silently printing the help screen for `gs --version`.
    if (arg === '--version' || arg === '--help') {
      positionals.push(arg);
      continue;
    }
    // `--` ends option parsing; everything after it is positional
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const name = arg.slice(2, eq);
        if (!VALUE_FLAGS.includes(`--${name}`) && !KNOWN_FLAGS.has(name)) {
          throw new UsageError(`unknown option --${name}`);
        }
        record(name, arg.slice(eq + 1));
      } else if (VALUE_FLAGS.includes(arg)) {
        const next = argv[++i];
        // `--home --json` used to take "--json" as the home directory, producing
        // a confusing "no profile found at --json\..." error.
        if (next === undefined || next === '--' || next.startsWith('--')) {
          throw new UsageError(`missing value for ${arg}`);
        }
        record(arg.slice(2), next);
      } else if (KNOWN_FLAGS.has(arg.slice(2))) {
        flags.add(arg.slice(2));
      } else {
        throw new UsageError(`unknown option ${arg}`);
      }
      continue;
    }
    positionals.push(arg);
  }

  const [command, ...rest] = positionals;
  if (command !== undefined) {
    // Reject trailing operands rather than dropping them: `gs diff typo` looked
    // like a successful run while the argument vanished without a trace.
    const expected = expectedArity(command, rest);
    if (expected !== undefined && rest.length > expected) {
      const extra = rest.slice(expected).join(' ');
      throw new UsageError(`unexpected argument${rest.length - expected > 1 ? 's' : ''}: ${extra}`);
    }
  }
  return { command, args: rest, flags, values };
}

/**
 * How many positional operands a command takes.
 *
 * Sub-commands carry their own budget: `key gen NAME` takes one, `key list` takes
 * none. A single number per command would let `gs key list EXTRA` through, which
 * is the same silent-drop bug this check exists to prevent.
 */
const ARITY: Record<string, number> = {
  init: 0,
  list: 0,
  diff: 0,
  apply: 0,
  doctor: 0,
  help: 0,
  version: 0,
  gui: 0,
  add: 1,
  key: 1,
  // `key list` = subcommand + 0 operands; `key gen NAME` = subcommand + 1
  'key list': 1,
  'key gen': 2,
  'key copy': 2,
  'key restore': 2,
  snapshot: 1,
  'snapshot export': 2,
  'snapshot import': 2,
};

function expectedArity(command: string | undefined, rest: string[]): number | undefined {
  if (command === undefined) return undefined;
  const sub = rest[0];
  if (sub !== undefined && ARITY[`${command} ${sub}`] !== undefined) {
    return ARITY[`${command} ${sub}`];
  }
  return ARITY[command];
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      // resolve language first so the message matches the rest of the output
      setLanguage(resolveLanguage(readRawLang(argv)));
      const logger = createLogger({ json: argv.includes('--json'), color: false });
      logger.error(err.message);
      logger.dim(t('usage.tryHelp'));
      return 2;
    }
    throw err;
  }
  const home = valueOf(args, 'home') ?? homedir();
  // language precedence: --lang, then GS_LANG, then the OS locale
  setLanguage(resolveLanguage(valueOf(args, 'lang')));

  // Report-style commands print an ordered narrative. Splitting errors and
  // warnings onto stderr would interleave with the stdout sections, so those
  // commands keep everything on one stream. `version`/`help` stay quiet.
  const REPORT_COMMANDS = new Set(['init', 'list', 'diff', 'apply', 'doctor', 'key', 'snapshot']);
  const logger = createLogger({
    json: args.flags.has('json'),
    // Colour is a presentation detail: enable it only for an interactive
    // terminal, honour NO_COLOR (https://no-color.org) and --no-color.
    // Previously the flag alone decided, so piping output kept ANSI escapes and
    // `NO_COLOR=1` was ignored.
    color: shouldUseColor(args, process.stdout),
    unifiedErrors: args.command !== undefined && REPORT_COMMANDS.has(args.command),
  });

  try {
  switch (args.command) {
    case undefined:
      case 'help':
      case '--help':
        process.stdout.write(usageText() + '\n');
        return 0;
      case 'version':
      case '--version': {
        const report = versionReport();

        // `--short` (and the plain `--version` spelling scripts use) keeps one line
        // so `gs --version` stays greppable, e.g. `gs --version | cut -d+ -f1`
        if (args.flags.has('short') || args.command === '--version') {
          process.stdout.write(`${report.version}\n`);
          return 0;
        }

        if (args.flags.has('json')) {
          logger.json(report);
          return 0;
        }

        const { package: pkg, build } = report;
        const line = (label: string, value: string | undefined) => {
          if (value === undefined || value === '') return;
          logger.dim(`${label.padEnd(10)}${value}`);
        };

        process.stdout.write(`${report.version}\n`);
        line(t('version.channel'), build.channel === 'release' ? t('version.release') : t('version.dev'));
        line(t('version.author'), pkg.author);
        line(t('version.license'), pkg.license);
        line(t('version.repository'), pkg.repository);
        line(t('version.commit'), build.commit);
        line(t('version.builtAt'), build.builtAt);
        if (build.dirty) logger.warn(`${t('version.dirtyLabel').padEnd(10)}${t('version.dirty')}`);
        return 0;
      }
      case 'init':
        return initCommand({
          home,
          ...(valueOf(args, 'root') !== undefined ? { roots: [valueOf(args, 'root') as string] } : {}),
          force: args.flags.has('force'),
          offline: args.flags.has('offline'),
          json: args.flags.has('json'),
          logger,
        });
      case 'list':
        return listCommand({ home, json: args.flags.has('json'), logger });
      case 'add':
        return addCommand({
          home,
          cwd: process.cwd(),
          ...(args.args[0] !== undefined ? { target: args.args[0] } : {}),
          ...(valueOf(args, 'identity') !== undefined ? { identity: valueOf(args, 'identity') } : {}),
          ...(valueOf(args, 'comment') !== undefined ? { comment: valueOf(args, 'comment') } : {}),
          force: args.flags.has('force'),
          dryRun: args.flags.has('dry-run'),
          json: args.flags.has('json'),
          logger,
        });
      case 'diff':
        return diffCommand({ home, json: args.flags.has('json'), logger });
      case 'apply':
        return applyCommand({
          home,
          json: args.flags.has('json'),
          dryRun: args.flags.has('dry-run'),
          force: args.flags.has('force'),
          logger,
        });
      case 'doctor':
        return doctorCommand({
          home,
          json: args.flags.has('json'),
          online: args.flags.has('online'),
          logger,
        });
      case 'gui': {
        // Validate numeric options here: passing NaN to server.listen raised an
        // ERR_SOCKET_BAD_PORT with a Node stack trace instead of a usage error.
        const port = parseIntegerFlag(args, 'port', { min: 1, max: 65535 });
        if (port instanceof UsageError) {
          logger.error(port.message);
          return 2;
        }
        const idle = parseIntegerFlag(args, 'idle-timeout', { min: 0 });
        if (idle instanceof UsageError) {
          logger.error(idle.message);
          return 2;
        }
        return guiCommand({
          home,
          ...(port !== undefined ? { port } : {}),
          open: !args.flags.has('no-open'),
          ...(idle !== undefined ? { idleTimeoutMinutes: idle } : {}),
          json: args.flags.has('json'),
          logger,
        });
      }
      case 'key':
        return keyCommand({
          home,
          subcommand: args.args[0],
          target: args.args[1],
          force: args.flags.has('force'),
          json: args.flags.has('json'),
          logger,
        });
      case 'snapshot':
        return snapshotCommand({
          home,
          subcommand: args.args[0],
          target: args.args[1],
          remaps: allOf(args, 'remap'),
          withKeys: args.flags.has('with-keys'),
          force: args.flags.has('force'),
          json: args.flags.has('json'),
          logger,
        });
      default:
        logger.error(t('error.unknownCommand', String(args.command)));
        process.stdout.write(usageText() + '\n');
        return 2;
  }
  } catch (err) {
    // A script that asked for --json must always get a document: an empty
    // stdout with a human sentence on stderr is exactly what --json exists to
    // avoid.
    if (logger.isJson) {
      logger.json({ error: err instanceof Error ? err.message : String(err), code: 2 });
    } else if (err instanceof ProfilesMissingError || err instanceof ModelError || err instanceof BlockError) {
      logger.error(err.message);
    } else {
      throw err;
    }
    return 2;
  }
}

const entry = process.argv[1];
const isDirectRun = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isDirectRun) {
  const wantsJson = process.argv.includes('--json');
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const known =
        err instanceof ProfilesMissingError || err instanceof ModelError || err instanceof BlockError;

      // A caller that asked for --json must always get a document, including when
      // the profile itself cannot be read: an empty stdout plus a human sentence
      // on stderr is exactly what machine-readable output exists to avoid.
      if (wantsJson) {
        process.stdout.write(`${JSON.stringify({ error: message, code: 2 })}\n`);
        process.exitCode = 2;
        return;
      }

      if (known) {
        process.stderr.write(`✗ ${message}\n`);
        process.exitCode = 2;
        return;
      }
      // Print the message, not the stack: an errno plus four internal frames is
      // not actionable for a user. GS_DEBUG=1 restores the stack for bug reports.
      process.stderr.write(`✗ ${message}\n`);
      if (process.env.GS_DEBUG === '1' && err instanceof Error && err.stack) {
        process.stderr.write(`${err.stack}\n`);
      }
      process.exitCode = 2;
    });
}