import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { languageOf } from './src/i18n.mjs';
import { isChildSession } from './src/child-guard.mjs';
import { bindDisplayBridgeSignals } from './src/display-bridge.mjs';
import { registerManagedDashboard, resolveDashboardNode, TodoPane } from './src/controller.mjs';

export function installedLanguage(environment = process.env) {
  let selected = 'en';
  try { selected = JSON.parse(readFileSync(new URL('./locale.json', import.meta.url), 'utf8')).language; }
  catch (error) { if (error.code !== 'ENOENT') console.warn('Todo pane: Cannot read locale configuration: '+error.message); }
  return languageOf(environment.OMO_HERDR_TODO_LANG ?? selected);
}

export default function extension(pi, { createController } = {}) {
  const eligible = ctx => {
    if (isChildSession(ctx?.sessionManager?.getSessionFile?.())) return false;
    return ctx?.hasUI === true && ctx.mode === 'tui' && process.env.HERDR_ENV === '1' &&
      Boolean(process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH);
  };
  const stateDir = process.env.OMO_HERDR_TODO_STATE_DIR ?? join(homedir(), '.omo', 'agent', 'herdr-todo');
  const service = registerManagedDashboard(pi, { stateDir,
    createController: createController ?? (ctx => new TodoPane({ ctx, cwd: pi.cwd, stateDir, managed: true,
      viewer: join(dirname(fileURLToPath(import.meta.url)), 'src/viewer.mjs'),
      node: () => resolveDashboardNode(),
      language: installedLanguage(),
      notify: message => ctx.ui.notify(message, 'warning') })) });
  bindDisplayBridgeSignals(pi, () => service.controller?.bridge);
  const start = async (event, ctx) => {
    // Static availability is load-time only; child identity still precedes all
    // context, filesystem, ownership and native work.
    if (!eligible(ctx)) return;
    await service.start(event, ctx);
  };
  pi.on('session_start', start);
  pi.on('session_tree', start);
  pi.on('session_shutdown', () => service.stop());
}
