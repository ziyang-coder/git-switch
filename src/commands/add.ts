import { homedir } from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { loadProfiles, saveProfiles } from '../core/profiles.ts';
import { gsPaths, contractHome, normaliseRulePath } from '../core/paths.ts';
import { upsertRule, RuleError } from '../core/rules.ts';
import { t } from '../core/i18n.ts';
import type { Logger } from '../util/log.ts';

export interface AddOptions {
  home?: string;
  cwd?: string;
  /** The directory argument; `.` when omitted. */
  target?: string;
  identity?: string | undefined;
  comment?: string | undefined;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  logger: Logger;
}

export interface AddResult {
  dir: string;
  identity: string;
  action: 'added' | 'replaced' | 'unchanged' | 'would-add';
  previousIdentity?: string;
  rulesBefore: number;
  rulesAfter: number;
  warnings: string[];
}

/**
 * `gs add [dir] --identity <name>`
 *
 * Binds a directory to an identity. Kept deliberately close to the GUI's rule
 * editor: both go through `upsertRule`, so the two paths cannot drift.
 */
export async function addCommand(opts: AddOptions): Promise<number> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const { logger } = opts;

  const identity = (opts.identity ?? '').trim();
  if (identity === '') {
    logger.error(t('add.missingIdentity'));
    return 2;
  }

  // an omitted target means "the directory you are standing in"
  const rawTarget = (opts.target ?? '.').trim() || '.';
  const dir = normaliseRulePath(rawTarget, home, cwd);

  // Refuse a file: `includeIf "gitdir:"` matches directories, and a typo such as
  // `gs add README.md` would otherwise produce a rule that silently never fires.
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      logger.error(t('add.notADirectory', contractHome(dir, home)));
      return 2;
    }
  } catch {
    // missing directories are allowed: people plan the layout before cloning
    logger.warn(t('add.doesNotExist', contractHome(dir, home)));
  }

  const profiles = await loadProfiles(home, cwd);
  const rulesBefore = profiles.rules.length;

  let outcome;
  try {
    outcome = upsertRule({
      profiles,
      dir,
      identity,
      ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
    });
  } catch (err) {
    if (err instanceof RuleError) {
      logger.error(err.message);
      // only the "already bound elsewhere" case has an obvious remedy
      if (err.kind === 'force-fixable') logger.dim(t('add.forceHint'));
      return 2;
    }
    throw err;
  }

  const rulesAfter = profiles.rules.length;

  if (outcome.action === 'unchanged') {
    if (opts.json) {
      logger.json({
        dir: contractHome(dir, home),
        identity,
        action: 'unchanged',
        rulesBefore,
        rulesAfter,
        warnings: outcome.warnings,
      } satisfies AddResult);
    } else {
      logger.ok(t('add.unchanged', contractHome(dir, home), identity));
    }
    return 0;
  }

  if (opts.dryRun) {
    if (opts.json) {
      logger.json({
        dir: contractHome(dir, home),
        identity,
        action: 'would-add',
        rulesBefore,
        rulesAfter,
        warnings: outcome.warnings,
      } satisfies AddResult);
    } else {
      logger.info(t('add.wouldAdd', contractHome(dir, home), identity));
      for (const warning of outcome.warnings) logger.warn(warning);
    }
    return 0;
  }

  // Persist through the same validation path as every other write: a rule that
  // the loader would reject must never reach disk.
  await saveProfiles(home, profiles);

  const result: AddResult = {
    dir: contractHome(dir, home),
    identity,
    action: outcome.action,
    ...(outcome.previousIdentity !== undefined ? { previousIdentity: outcome.previousIdentity } : {}),
    rulesBefore,
    rulesAfter,
    warnings: outcome.warnings,
  };

  if (opts.json) {
    logger.json(result);
    return 0;
  }

  if (outcome.action === 'replaced') {
    logger.ok(t('add.replaced', contractHome(dir, home), outcome.previousIdentity ?? '?', identity));
  } else {
    logger.ok(t('add.added', contractHome(dir, home), identity));
  }
  logger.dim(t('add.ruleCount', rulesBefore, rulesAfter));

  for (const warning of outcome.warnings) logger.warn(warning);

  // the rule is inert until `apply` writes the includeIf block
  logger.dim(t('add.next'));
  logger.dim(t('list.profile', contractHome(gsPaths(home).profiles, home)));
  return 0;
}
