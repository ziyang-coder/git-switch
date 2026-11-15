/**
 * Change planning.
 *
 * `plan()` is pure with respect to the filesystem: it reads the current state and
 * returns a list of operations describing what `apply()` would do. The CLI
 * renders it as a text diff; the GUI renders it as a visual diff. Both consume
 * the same object, so they can never disagree.
 */

import path from 'node:path';
import type { Profiles } from './model.ts';
import { contentHash, detectEol, findBlock, recordedHash, stripHashLine, HASH_PREFIX, upsertBlock } from './managed-block.ts';
import { renderIdentityConfig, renderIncludeIfBlock } from './render/gitconfig.ts';
import { aliasesForIdentity, buildHostsDetailed, renderSshBlock } from './render/ssh-config.ts';
import { contractHome, gsPaths, realCasePath, toPlatform } from './paths.ts';
import { exists, readFileIfExists } from '../util/fs-atomic.ts';

export type OpKind = 'create' | 'update' | 'delete' | 'unchanged';

export interface FileOp {
  kind: OpKind;
  /** absolute path on disk, or null for the global git config (which is identified by scope) */
  file: string;
  /** human readable label, home-contracted */
  label: string;
  scope: 'global-gitconfig' | 'identity-config' | 'ssh-config';
  before?: string;
  after?: string;
  /** true when a managed block exists but its content was edited by hand */
  foreignOverride?: ForeignOverride;
  error?: string;
}

export interface ForeignOverride {
  /** user has manually set the same key outside the block */
  keys: string[];
}

export interface Plan {
  ops: FileOp[];
  /** files whose effective values are shadowed by manual settings in the same file */
  warnings: string[];
  errors: string[];
  /** changes are pending if any op is not 'unchanged' */
  dirty: boolean;
}

export interface PlanOptions {
  home: string;
  profiles: Profiles;
  /** read current file contents; injectable for tests */
  readFile?: (file: string) => Promise<string | undefined>;
  /**
   * Overwrite blocks that contain hand edits. The hand-edit error tells the user
   * to pass --force, so the flag has to actually reach this decision.
   */
  force?: boolean;
}

export async function plan(opts: PlanOptions): Promise<Plan> {
  const { home, profiles: rawProfiles } = opts;
  const read = opts.readFile ?? readFileIfExists;
  const paths = gsPaths(home);
  const contract = (p: string) => contractHome(p, home);
  const identityConfigPath = (identity: string) =>
    path.join(paths.identitiesDir, `${identity}.gitconfig`);

  // Align rule paths with the casing that exists on disk. git's `gitdir:` match
  // is case sensitive, so `/code/github` would never match `/code/GitHub`.
  const profiles = await withRealCasing(rawProfiles, home);

  const ops: FileOp[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  /**
   * Read a target file, turning an I/O failure into a plan error.
   *
   * `readFileIfExists` only swallows ENOENT. Everything else — a path that is a
   * directory, a permission problem — used to escape the surrounding try/catch
   * and reject `plan()` outright, which made one bad file abort the whole apply.
   *
   * Returns `undefined` for "cannot read"; `null` still means "file is absent",
   * which the caller needs in order to report a `create` rather than an `update`.
   */
  const readOrRecordError = async (file: string): Promise<string | null | undefined> => {
    try {
      return (await read(file)) ?? null;
    } catch (err) {
      errors.push(`${contract(file)}: ${(err as Error).message}`);
      return undefined;
    }
  };

  /* ---- ~/.gitconfig includeIf block ---- */
  const gitconfigRaw = await readOrRecordError(paths.globalGitConfig);
  if (gitconfigRaw !== undefined) {
    const gitconfigBefore = gitconfigRaw ?? '';
    try {
      const body = renderIncludeIfBlock(profiles, { identityConfigPath, contract });
      // A line the generator would not produce means the user edited the block by
      // hand; rewriting it would silently destroy that edit.
      const handEdited = opts.force ? [] : findHandEdits(gitconfigBefore, body);
      const after = upsertBlock(gitconfigBefore, body);
      if (handEdited.length > 0) {
        // still report the op so `dirty` is true, but make apply() refuse: the
        // user's edit would be destroyed by rewriting the block
        errors.push(
          `${contract(paths.globalGitConfig)}: the managed block contains edits gs did not generate ` +
            `(${handEdited.join(' | ')}). Re-run with --force to overwrite, or move them into profiles.yaml.`,
        );
      }
      const foreign = detectForeignKeys(gitconfigBefore);
      if (foreign.length > 0) {
        warnings.push(
          `${contract(paths.globalGitConfig)} already contains includeIf entries outside the gs block: ` +
            foreign.join(', ') +
            '. gs will not modify them; they may take precedence over generated rules.',
        );
      }
      ops.push(
        makeOp(paths.globalGitConfig, contract(paths.globalGitConfig), gitconfigBefore, after, 'global-gitconfig'),
      );
    } catch (err) {
      errors.push(`${contract(paths.globalGitConfig)}: ${(err as Error).message}`);
    }
  }

  /* ---- per-identity git configs ---- */
  for (const identity of profiles.identities) {
    const file = identityConfigPath(identity.name);
    const before = await readOrRecordError(file);
    if (before === undefined) continue;
    try {
      const body = renderIdentityConfig(profiles, identity.name, {
        aliasFor: (name) => aliasesForIdentity(profiles, name),
      });
      const after = withTrailingNewline(body);
      ops.push(makeOp(file, contract(file), before ?? undefined, after, 'identity-config'));
    } catch (err) {
      errors.push(`${contract(file)}: ${(err as Error).message}`);
    }
  }

  /* ---- ~/.ssh/config host block ---- */
  const sshRaw = await readOrRecordError(paths.sshConfig);
  if (sshRaw !== undefined) {
    const sshBefore = sshRaw ?? '';
    try {
      const built = buildHostsDetailed(profiles);
      const rendered = renderSshBlock(built.hosts);
      const handEdited = opts.force ? [] : findHandEdits(sshBefore, rendered);
      const after = upsertBlock(sshBefore, rendered);
      if (handEdited.length > 0) {
        errors.push(
          `${contract(paths.sshConfig)}: the managed block contains edits gs did not generate ` +
            `(${handEdited.join(' | ')}). Re-run with --force to overwrite, or move them into profiles.yaml.`,
        );
      }
      for (const site of built.skipped) {
        warnings.push(
          `${site.host}: no SSH key for identity "${site.identity}", so no Host block is generated ` +
            `for it. Set sshKey on the identity (or the site) to enable it.`,
        );
      }
      const foreign = detectForeignHosts(sshBefore, built.hosts.map((h) => h.alias));
      if (foreign.length > 0) {
        warnings.push(
          `${contract(paths.sshConfig)} already defines Host ${foreign.join(', ')} outside the gs block. ` +
            'OpenSSH uses the first match, so those entries win.',
        );
      }
      ops.push(makeOp(paths.sshConfig, contract(paths.sshConfig), sshBefore, after, 'ssh-config'));
    } catch (err) {
      errors.push(`${contract(paths.sshConfig)}: ${(err as Error).message}`);
    }
  }

  /* ---- preflight: credentials that cannot possibly work ---- */
  for (const identity of profiles.identities) {
    if (!identity.sshKey) continue;
    const keyPath = path.join(paths.sshDir, identity.sshKey);
    if (!(await exists(keyPath))) {
      const sites = profiles.sites.filter((s) => s.identity === identity.name).map((s) => s.host);
      warnings.push(
        `identity "${identity.name}" references ~/.ssh/${identity.sshKey}, which does not exist` +
          (sites.length > 0 ? ` (used by ${sites.join(', ')})` : '') +
          `. SSH will fail until the key is created; run \`gs doctor\` for details.`,
      );
    }
  }

  return {
    ops,
    warnings,
    errors,
    dirty: ops.some((op) => op.kind !== 'unchanged'),
  };
}

function makeOp(
  file: string,
  label: string,
  before: string | undefined,
  after: string,
  scope: FileOp['scope'],
): FileOp {
  const beforeText = before ?? '';
  if (before === undefined) {
    if (after === '') return { kind: 'unchanged', file, label, scope };
    return { kind: 'create', file, label, scope, after };
  }
  if (beforeText === after) return { kind: 'unchanged', file, label, scope, before: beforeText, after };
  return { kind: 'update', file, label, scope, before: beforeText, after };
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

/** Copy of the profile whose rule paths use the on-disk casing. */
async function withRealCasing(profiles: Profiles, home: string): Promise<Profiles> {
  const rules = await Promise.all(
    profiles.rules.map(async (rule) => ({ ...rule, dir: await realCasePath(rule.dir, home) })),
  );
  const repositories = await Promise.all(
    profiles.repositories.map(async (repo) => ({ ...repo, path: await realCasePath(repo.path, home) })),
  );
  return { ...profiles, rules, repositories };
}

/** includeIf entries that live outside our block would shadow generated rules. */
function detectForeignKeys(text: string): string[] {
  const block = safeBlock(text);
  const outside = block.present ? text.slice(0, block.start) + text.slice(block.end) : text;
  const found: string[] = [];
  for (const line of outside.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\[includeIf\b/i.test(t)) found.push(t);
  }
  return found;
}

function detectForeignHosts(text: string, aliases: string[]): string[] {
  const block = safeBlock(text);
  const outside = block.present ? text.slice(0, block.start) + text.slice(block.end) : text;
  const wanted = new Set(aliases.map((a) => a.toLowerCase()));
  const found = new Set<string>();
  for (const line of outside.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    if (!m || !m[1]) continue;
    for (const name of m[1].trim().split(/\s+/)) {
      if (wanted.has(name.toLowerCase())) found.add(name);
    }
  }
  return [...found];
}

function safeBlock(text: string) {
  try {
    return findBlock(text);
  } catch {
    return { present: false, content: '', start: -1, end: -1, broken: true };
  }
}

export { detectEol, toPlatform };

/**
 * Whether the existing managed block was edited by hand since gs wrote it.
 *
 * The block records a hash of the body it was generated from. Comparing that
 * stamp against the body currently on disk answers the question exactly:
 *
 *   - the profile changed and gs has not rewritten the file yet -> hash matches
 *   - a rule was removed or re-pointed                          -> hash matches
 *   - the user added, changed or deleted a line                 -> hash differs
 *
 * A block written by an older gs has no stamp; it is treated as clean so the
 * first run after an upgrade simply writes one.
 *
 * `renderedBody` is only used to name the offending lines in the message.
 */
function findHandEdits(existingText: string, renderedBody: string): string[] {
  const block = findBlock(existingText);
  if (!block?.content) return [];

  const recorded = recordedHash(block.content);
  if (recorded === undefined) return [];

  const onDisk = stripHashLine(block.content);
  if (recorded === contentHash(onDisk)) return [];

  // Lines present now that the generator would not produce are the likely edits;
  // fall back to the first line at all if every line looks generated.
  const generated = new Set(
    renderedBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  const lines = onDisk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const unexpected = lines.filter((line) => !generated.has(line));
  const named = unexpected.length > 0 ? unexpected : lines;
  return named.slice(0, 3).map((line) => line.slice(0, 60));
}
