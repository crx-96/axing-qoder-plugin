import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const asset = name => readFileSync(new URL(`../server/panel/core-update.${name}`, import.meta.url), 'utf8');
const script = asset('js');
const html = asset('html');
const status = (state, version = '2', extra = {}) => ({ core: { version: '1' }, update: { state, version, ...extra } });

function setup() {
  const nodes = {};
  for (const match of html.matchAll(/<[\w]+\b[^>]*\bdata-part="([\w]+)"[^>]*>/g)) {
    const part = match[1];
    nodes[part] = {
      dataset: { part }, hidden: /\bhidden\b/.test(match[0]), disabled: /\bdisabled\b/.test(match[0]),
      closest() { return this; }, focus() { this.focused = true; },
      setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; },
      set innerHTML(_) { assert.fail('动态内容须用 textContent'); },
    };
  }
  const timers = new Map();
  let sequence = 0;
  let listener;
  const root = {
    querySelectorAll() { return Object.values(nodes); },
    addEventListener(_, fn) { assert.equal(listener, undefined); listener = fn; },
    removeEventListener(_, fn) { assert.equal(listener, fn); listener = undefined; },
  };
  const create = vm.runInNewContext(`${script}\ncreateUpdatePanel`, {
    setTimeout(fn) { timers.set(++sequence, fn); return sequence; }, clearTimeout(id) { timers.delete(id); },
  });
  const calls = [];
  const f = {
    nodes, timers, calls, reads: 0, current: status('idle'), reply: async () => ({}),
    read: () => { f.panel.render(f.current); },
    open() {
      f.panel = create({ root, request(method, params, timeout) {
        calls.push({ method, ...JSON.parse(JSON.stringify(params)), timeout });
        return f.reply();
      }, readStatus() { f.reads++; return f.read(); } });
    },
    click(part) { return listener?.({ target: nodes[part] }); },
    tick() {
      assert.equal(timers.size, 1);
      const [[id, fn]] = timers;
      timers.delete(id);
      return fn();
    },
  };
  f.open();
  return f;
}

test('连接后的自动检查只执行一次；手动复查失败后可重试', async () => {
  const f = setup();
  f.panel.initialize(null);
  assert.equal(f.calls.length, 0);
  f.current = status('current');
  await Promise.all([f.panel.initialize(status('idle')), f.panel.initialize(status('idle')), f.click('check')]);
  assert.deepEqual(f.calls, [{ method: 'tools/call', name: 'bridge_check_update', arguments: {}, timeout: 30000 }]);
  assert.match(f.nodes.message.textContent, /最新/);
  f.reply = async () => ({ isError: true, content: [{ text: '{"reason":"<img onerror=x>"}' }] });
  await f.click('check');
  assert.equal(f.nodes.reason.textContent, '<img onerror=x>');
  assert.equal(f.nodes.check.disabled, false);
  f.reply = async () => ({});
  await f.click('check');
  assert.equal(f.nodes.reason.hidden, true);
  assert.equal(f.calls.length, 3);
});

test('长下载使用公共查询显示真实进度，收尾再获取就绪快照', async () => {
  const f = setup();
  f.current = status('available');
  await f.panel.initialize(f.current);
  const download = Promise.withResolvers();
  f.reply = () => download.promise;
  const finished = f.click('download');
  f.click('download');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].name, 'bridge_download_update');
  assert.deepEqual(f.calls[1].arguments, { version: '2' });
  assert.match(f.nodes.message.textContent, /当前版本可继续使用/);
  const progress = Promise.withResolvers();
  f.read = () => progress.promise;
  const polling = f.tick();
  assert.equal(f.timers.size, 0);
  download.resolve({});
  f.current = status('staged');
  f.read = () => f.current;
  progress.resolve(status('downloading', '2', { progress: { phase: 'downloading', receivedBytes: 37, totalBytes: 100 } }));
  await polling;
  await finished;
  assert.equal(f.nodes.bar.value, 37);
  assert.equal(f.nodes.bar.max, 100);
  assert.match(f.nodes.running.textContent, /1/);
  assert.match(f.nodes.message.textContent, /2 已就绪/);
  assert.equal(f.nodes.meter.hidden, true);
  assert.equal(f.nodes.switch.hidden, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 2);
});

test('切换需要确认同一版本，稍后切换返回焦点，重复确认不重发', async () => {
  const f = setup();
  f.current = status('staged');
  await f.panel.initialize(f.current);
  assert.deepEqual(f.calls.splice(0).map(call => call.name), ['bridge_check_update']);
  f.click('confirm');
  f.click('switch');
  assert.equal(f.nodes.cancel.focused, true);
  assert.equal(f.nodes.confirmation.hidden, false);
  assert.equal(f.nodes.switch['aria-expanded'], 'true');
  f.click('cancel');
  assert.equal(f.nodes.switch.focused, true);
  f.click('confirm');
  f.click('switch');
  f.panel.render(status('staged', '3'));
  f.click('confirm');
  assert.equal(f.calls.length, 0);
  f.click('switch');
  f.current = { ...status('current', null), core: { version: '3' } };
  await Promise.all([f.click('confirm'), f.click('confirm')]);
  assert.deepEqual(f.calls.map(c => [c.name, c.arguments]), [['bridge_apply_update', { version: '3' }]]);
  assert.match(f.nodes.running.textContent, /3/);
  assert.equal(f.nodes.confirmation.hidden, true);
});

test('重开接续下载；慢读取、暂时错误与关闭后迟到响应均可释放', async () => {
  const f = setup();
  f.current = status('downloading', '2', { progress: { phase: 'verifying', receivedBytes: 5, totalBytes: null } });
  f.panel.initialize(f.current);
  assert.match(f.nodes.amount.textContent, /正在校验.*5/);
  assert.equal(f.nodes.bar.value, undefined);
  f.read = async () => { throw Error('暂时断开'); };
  await f.tick();
  assert.match(f.nodes.reason.textContent, /重试/);
  f.read = () => f.current;
  await f.tick();
  assert.equal(f.nodes.reason.hidden, true);
  const late = Promise.withResolvers();
  f.read = () => late.promise;
  const polling = f.tick();
  f.panel.dispose();
  f.open();
  f.panel.initialize(status('custom', null, { reason: '<custom>' }));
  late.resolve(status('switching'));
  await polling;
  assert.equal(f.nodes.reason.textContent, '<custom>');
  assert.equal(f.nodes.check.disabled, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
});

test('指定版本先校验输入，可下载旧版而不调用切换', async () => {
  const f = setup();
  f.current = status('staged');
  await f.panel.initialize(f.current);
  assert.deepEqual(f.calls.splice(0).map(call => call.name), ['bridge_check_update']);
  f.nodes.tag.value = '../bad';
  await f.click('specified');
  assert.match(f.nodes.reason.textContent, /版本号/);
  assert.equal(f.calls.length, 0);
  f.nodes.tag.value = ' 0.1.4520 ';
  f.current = { ...status('current'), installedVersions: [{ version: 'v0.1.4520', active: false }] };
  await f.click('specified');
  assert.match(f.nodes.message.textContent, /指定版本 v0\.1\.4520 已列入「已安装版本」/);
  assert.deepEqual(f.calls.map(c => [c.name, c.arguments]), [['bridge_download_version', { version: 'v0.1.4520' }]]);
});

test('关闭仍在等待的下载后不补发查询，重开保留服务端错误及重试入口', async () => {
  const f = setup();
  f.current = status('available');
  await f.panel.initialize(f.current);
  const late = Promise.withResolvers();
  f.reply = () => late.promise;
  const pending = f.click('download');
  f.panel.dispose();
  assert.equal(f.timers.size, 0);
  late.reject(Error('closed'));
  await pending;
  assert.equal(f.reads, 1);
  f.open();
  f.current = status('error', null, { reason: '校验失败' });
  f.reply = async () => ({});
  await f.panel.initialize(f.current);
  assert.equal(f.nodes.reason.textContent, '校验失败');
  assert.equal(f.nodes.check.disabled, false);
});
