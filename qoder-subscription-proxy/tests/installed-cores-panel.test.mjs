import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cdpClient, connectBrowser } from './helpers/browser.mjs';

const browser = process.env.BRIDGE_TEST_BROWSER;
test('行内确认绑定版本、焦点与权威状态，删除和切换完成后刷新', { skip: !browser, timeout: 90000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'core-list-browser-'));
  const child = spawn(browser, ['--headless=new', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  let socket, send;
  t.after(async () => {
    if (send) await send('Browser.close').catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    socket?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  socket = await connectBrowser(profile);
  send = cdpClient(socket);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(exceptionDetails, undefined, exceptionDetails?.exception?.description);
    return result.value;
  };
  const script = await readFile(new URL('../server/panel/installed-cores.js', import.meta.url), 'utf8');
  await evaluate(`${script}
    const root = document.body.appendChild(document.createElement('section'));
    root.style.width = '200px'; root.style.colorScheme = 'light dark';
    let reads = 0; const calls = [];
    const current = { installedVersions: [{version:'v2',sizeBytes:128,active:true},{version:'v1',sizeBytes:64,active:false}], update:{state:'idle'} };
    const panel = createInstalledCoresPanel({root, async request(method,params) { calls.push(params); }, async readStatus() { reads++; return current; }});
    const control = key => root.querySelector('[data-focus="'+key+'"]');
    panel.render(current); void 0;`);
  assert.equal(await evaluate(`control('v2-delete').disabled && control('v2-apply').disabled`), true);
  assert.equal(await evaluate(`control('v1-delete').click(); document.activeElement.dataset.focus`), 'v1-cancel');
  assert.equal(await evaluate(`root.scrollWidth === root.clientWidth && root.textContent.includes('账号和数据将保留')`), true);
  assert.equal(await evaluate(`panel.render(current); control('v1-cancel').click(); document.activeElement.dataset.focus`), 'v1-delete');
  assert.equal(await evaluate(`control('v1-apply').click(); current.update={state:'switching',version:'v1'}; panel.render(current); !control('v1-confirm') && calls.length===0`), true);
  await evaluate(`current.update={state:'idle'}; panel.render(current)`);
  for (const [kind, name] of [['apply', 'bridge_apply_update'], ['delete', 'bridge_delete_version']]) {
    await evaluate(`control('v1-${kind}').click(); control('v1-confirm').click(); new Promise(resolve => setTimeout(resolve, 0))`);
    assert.deepEqual(await evaluate('calls.at(-1)'), { name, arguments: { version: 'v1' } });
  }
  assert.equal(await evaluate('reads'), 2);
});
