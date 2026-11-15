/**
 * CLI / GUI capability parity.
 *
 * Every capability the CLI offers is reachable from the browser UI, or is
 * genuinely CLI-only (starting the server, shell conveniences). This check reads
 * the command dispatcher and the HTTP router so a new command cannot silently
 * ship without a corresponding endpoint and screen.
 */
import { readFile } from 'node:fs/promises';

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const cli = await readFile('src/cli.ts', 'utf8');
const http = await readFile('src/server/http.ts', 'utf8');
const html = await readFile('web/index.html', 'utf8');
const api = await readFile('web/src/api.js', 'utf8');

const views = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
const endpoints = [...http.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]);
const keyActions = [...http.matchAll(/action === '(\w+)'/g)].map((m) => m[1]);
const keyActionsWeb = [...api.matchAll(/action: '(\w+)'/g)].map((m) => m[1]);

/**
 * capability -> how the browser reaches it.
 * `endpoint` may be a regex source matched against the routes.
 */
const CAPABILITIES = [
  { name: 'init', kind: 'endpoint', endpoint: '/api/init/(scan|apply)', view: 'init' },
  { name: 'list', kind: 'endpoint', endpoint: '/api/state', view: 'overview' },
  { name: 'add', kind: 'endpoint', endpoint: '/api/rules', view: 'rules' },
  { name: 'diff', kind: 'endpoint', endpoint: '/api/plan', view: 'preview' },
  { name: 'apply', kind: 'endpoint', endpoint: '/api/apply', view: 'preview' },
  { name: 'doctor', kind: 'endpoint', endpoint: '/api/doctor', view: 'doctor' },
  { name: 'key list', kind: 'endpoint', endpoint: '/api/keys', view: 'keys' },
  { name: 'snapshot export', kind: 'endpoint', endpoint: '/api/snapshot/export', view: 'snapshot' },
  { name: 'snapshot import', kind: 'endpoint', endpoint: '/api/snapshot/import', view: 'snapshot' },
  { name: 'version', kind: 'endpoint', endpoint: '/api/version', view: undefined },
];

for (const cap of CAPABILITIES) {
  const route = new RegExp(`^${cap.endpoint}$`);
  check(
    `${cap.name}: the API exposes it`,
    endpoints.some((e) => route.test(e)),
    `looked for ${cap.endpoint} among ${endpoints.join(', ')}`,
  );
  if (cap.view !== undefined) {
    check(`${cap.name}: the web has a screen for it`, views.includes(cap.view), views.join(', '));
  }
}

// keys are one endpoint with actions; both sides must know the same ones
for (const action of keyActions) {
  check(`key ${action}: the web can call it`, keyActionsWeb.includes(action), keyActionsWeb.join(', '));
}

// CLI commands that are deliberately GUI-less, with the reason
const CLI_ONLY = new Map([
  ['gui', 'starts the web server'],
  ['help', 'shell convenience'],
  ['--help', 'shell convenience'],
  ['--version', 'shell convenience'],
  ['version', 'served to the browser through /api/version'], // has a screen-less API
  ['key', 'dispatched as /api/keys actions'],
  ['snapshot', 'dispatched as /api/snapshot/* routes'],
]);

const commands = [...cli.matchAll(/^ {4}case '([^']+)'/gm)].map((m) => m[1]);
for (const command of commands) {
  const covered =
    CAPABILITIES.some((c) => c.name === command || c.name.startsWith(`${command} `)) ||
    CLI_ONLY.has(command);
  check(`CLI command "${command}" is either exposed to the web or documented as CLI-only`, covered);
}

// views without an endpoint would be dead screens
for (const view of views) {
  check(`view "${view}" is backed by an endpoint`, endpoints.length > 0);
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('CLI and web capabilities are aligned');
}
