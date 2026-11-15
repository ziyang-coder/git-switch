/**
 * Adding a directory to an identity.
 *
 * Shared by `gs add` and the GUI's `/api/rules` endpoint so the two can never
 * disagree about what "add this directory to that identity" means.
 */

import type { Profiles } from './model.ts';
import { t } from './i18n.ts';

export interface UpsertRuleOptions {
  profiles: Profiles;
  /** Already normalised through `normaliseRulePath` by the caller. */
  dir: string;
  identity: string;
  comment?: string;
  /** Replace an existing rule that points at a different identity. */
  force?: boolean;
}

export interface UpsertRuleResult {
  action: 'added' | 'replaced' | 'unchanged';
  /** The identity the directory pointed at before, when it changed. */
  previousIdentity?: string;
  /** Non-fatal observations, e.g. a parent rule already exists. */
  warnings: string[];
}

export class RuleError extends Error {
  /** `force-fixable` means the caller can retry with `force: true`. */
  readonly kind: 'unknown-identity' | 'force-fixable';

  constructor(message: string, kind: 'unknown-identity' | 'force-fixable') {
    super(message);
    this.name = 'RuleError';
    this.kind = kind;
  }
}

/**
 * Add or replace one directory rule in place.
 *
 * Mutates `profiles.rules`; the caller persists. Rules are prepended rather than
 * appended so the new, more specific rule is examined first — `resolveIdentity`
 * returns the first match, and a user adding `~/code/github` after `~/code`
 * expects the narrower one to win.
 */
export function upsertRule(opts: UpsertRuleOptions): UpsertRuleResult {
  const { profiles, dir, force } = opts;
  const warnings: string[] = [];

  if (!profiles.identities.some((i) => i.name === opts.identity)) {
    const available = profiles.identities.map((i) => i.name).join(', ');
    throw new RuleError(t('add.unknownIdentity', opts.identity, available), 'unknown-identity');
  }

  const existing = profiles.rules.find((r) => r.dir === dir);
  if (existing) {
    if (existing.identity === opts.identity) {
      // identical rule: report it rather than rewriting the file
      if (opts.comment !== undefined && existing.comment !== opts.comment) {
        existing.comment = opts.comment;
        return { action: 'replaced', warnings };
      }
      return { action: 'unchanged', warnings };
    }
    if (!force) {
      throw new RuleError(t('add.alreadyBound', dir, existing.identity), 'force-fixable');
    }
    const previousIdentity = existing.identity;
    existing.identity = opts.identity;
    if (opts.comment !== undefined) existing.comment = opts.comment;
    return { action: 'replaced', previousIdentity, warnings };
  }

  // An existing rule on a parent directory already covers this one; the new,
  // narrower rule wins because matching prefers the longest path.
  const parent = profiles.rules.find((r) => isParentOf(r.dir, dir));
  if (parent) warnings.push(t('add.parentExists', parent.dir, parent.identity));

  // The reverse is worth saying too: the new rule makes an existing sub-rule
  // redundant, and the user probably meant this one to cover everything below.
  const covered = profiles.rules.filter((r) => isParentOf(dir, r.dir));
  if (covered.length > 0) {
    warnings.push(
      t('add.coversChildren', covered.map((r) => r.dir).join(', ')),
    );
  }

  const rule: (typeof profiles.rules)[number] = { dir, identity: opts.identity };
  if (opts.comment !== undefined && opts.comment !== '') rule.comment = opts.comment;
  profiles.rules.unshift(rule);

  return { action: 'added', warnings };
}

/** `parent` contains `child` (whole path segments only). */
function isParentOf(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, '');
  const c = child.replace(/\/+$/, '');
  return p !== c && c.startsWith(`${p}/`);
}

export interface RemoveRuleResult {
  removed: boolean;
  identity?: string;
}

/** Remove the rule for a directory, if one exists. */
export function removeRule(profiles: Profiles, dir: string): RemoveRuleResult {
  const index = profiles.rules.findIndex((r) => r.dir === dir);
  if (index === -1) return { removed: false };
  const identity = profiles.rules[index]?.identity;
  profiles.rules.splice(index, 1);
  return { removed: true, ...(identity !== undefined ? { identity } : {}) };
}
