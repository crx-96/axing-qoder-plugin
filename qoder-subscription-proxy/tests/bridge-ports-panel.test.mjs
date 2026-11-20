import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { blockedManagementPorts } from '../server/bridge-ports.mjs';

const asset = extension => readFile(new URL(`../server/panel/bridge-ports.${extension}`, import.meta.url), 'utf8');
const [html, script] = await Promise.all([asset('html'), asset('js')]);
const status = (overrides = {}) => ({ ports: { modelPort: 19787, managementPort: 19788, modelLocked: false, managementLocked: false, ...overrides } });
const textResult = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError });

function setup() {
  const nodes = {}, listeners = new Map(), calls = [];
  for (const [tag, type, part] of html.matchAll(/<(\w+)\b[^>]*\bdata-part="(\w+)"[^>]*>/g)) {
    const value = tag.match(/\bvalue="([^"]*)"/)?.[1] || '';
    nodes[part] = {
      tag, value, defaultValue: value, dataset: { part }, textContent: '',
      hidden: /\bhidden\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
      closest: () => type === 'button' ? nodes[part] : null,
      setAttribute(key, val) { this[key] = val; }, removeAttribute(key) { delete this[key]; },
      focus() { f.focus = part; }, set innerHTML(_) { assert.fail('诊断内容只能作为文本展示'); },
    };
  }
  const root = {
    hidden: true, querySelectorAll: () => Object.values(nodes),
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { assert.equal(listeners.get(type), fn); listeners.delete(type); },
  };
  const create = runInNewContext(`${script}\ncreatePortPanel`, {
    blockedManagementPorts,
    document: { querySelector(selector) { assert.equal(selector, '#bridge-ports'); return root; } },
  });
  const f = {
    nodes, root, calls, reads: 0, current: status(),
    reply: () => textResult(f.current), read: () => f.current,
    render(value) { f.current = value; f.panel.render(value); },
    input(part, value) {
      assert.equal(nodes[part].disabled, false);
      nodes[part].value = value;
      listeners.get('input')?.({ target: nodes[part] });
    },
    click(part) { return listeners.get('click')?.({ target: nodes[part] }); },
  };
  f.panel = create({ request(method, params) { calls.push({ method, ...structuredClone(params) }); return f.reply(); }, readStatus() { f.reads++; return f.read(); } });
  return f;
}

test('端口设置默认收起，两个数字输入有对应标签、范围、默认值和操作说明', () => {
  const { nodes } = setup();
  assert.match(html, /<details>\s*<summary[^>]*>端口设置<\/summary>/);
  for (const [part, label, port] of [['modelPort', '模型端口', '19787'], ['managementPort', '浏览器管理端口', '19788']]) {
    const { tag, defaultValue } = nodes[part];
    const id = tag.match(/\bid="([^"]+)"/)[1];
    assert.ok(html.includes(`<label for="${id}">${label}</label>`));
    for (const attr of ['type="number"', 'min="1"', 'max="65535"', 'step="1"', 'required']) assert.ok(tag.includes(attr));
    assert.equal(defaultValue, port);
    assert.ok(html.includes(`默认 ${port}`));
  }
  assert.match(html, /代理可能短暂重启.*Base URL.*原生管理页.*Agent.*重新同步/);
  assert.match(html, /data-part="save"[^>]*data-primary="true"[^>]*>保存并应用/);
});

test('只读快照更新干净字段，保留未完成输入；手动改回生效值后恢复跟随轮询', () => {
  const f = setup();
  f.render({});
  assert.equal(f.root.hidden, true);
  f.render(status({ modelPort: 0 }));
  assert.equal(f.nodes.modelPort.disabled, true);
  f.click('save');
  f.click('confirm');
  f.render(status());
  assert.equal(f.root.hidden, false);
  f.input('modelPort', '');
  f.render(status({ modelPort: 30000, managementPort: 31000 }));
  assert.equal(f.nodes.modelPort.value, '');
  assert.equal(f.nodes.managementPort.value, '31000');
  f.input('modelPort', '30000');
  f.render(status({ modelPort: 30001 }));
  assert.equal(f.nodes.modelPort.value, '30001');
  assert.equal(f.nodes.save.disabled, true);
  assert.deepEqual(f.calls, []);
});

for (const [key, lock, other, otherLock] of [
  ['modelPort', 'modelLocked', 'managementPort', 'managementLocked'],
  ['managementPort', 'managementLocked', 'modelPort', 'modelLocked'],
]) {
  test(`环境覆盖单独禁用 ${key} 并展示原因，恢复默认只改可编辑字段`, async () => {
    const f = setup();
    f.render(status({ [other]: 30500 }));
    f.input(key, '40404');
    f.render(status({ [key]: 30303, [lock]: true, [other]: 30500 }));
    assert.equal(f.nodes[key].disabled, true);
    assert.equal(f.nodes[key].value, '30303');
    assert.equal(f.nodes[lock].hidden, false);
    assert.equal(f.nodes[otherLock].hidden, true);
    assert.equal(f.nodes[other].disabled, false);
    f.click('defaults');
    assert.equal(f.nodes[key].value, '30303');
    assert.equal(f.nodes[other].value, f.nodes[other].defaultValue);
    f.click('save');
    assert.equal(f.calls.length, 0);
    f.read = () => status({ [key]: 30303, [lock]: true });
    await f.click('confirm');
    const expectedModelPort = key === 'modelPort' ? 30303 : 30500;
    const expectedManagementPort = key === 'managementPort' ? 30303 : 30500;
    assert.deepEqual(f.calls[0].arguments, { modelPort: 19787, managementPort: 19788, [key]: 30303, expectedModelPort, expectedManagementPort });
    f.render(status({ modelLocked: true, managementLocked: true }));
    assert.equal(f.nodes.save.disabled, true);
    assert.equal(f.nodes.defaults.disabled, true);
    f.render(status());
    assert.equal(f.nodes[key].value, '40404');
    assert.equal(f.calls.length, 1);
  });
}

test('空值、小数、指数、越界以及端口相同均给出具体提示，冲突时聚焦可编辑字段', () => {
  const f = setup();
  f.render(status({ managementLocked: true }));
  for (const value of ['', '-1', '0', '65536', '1.5', '1e3']) {
    f.input('modelPort', value);
    f.click('save');
    assert.match(f.nodes.message.textContent, /模型端口.*1 到 65535.*整数/);
    assert.equal(f.focus, 'modelPort');
    assert.equal(f.nodes.modelPort['aria-invalid'], 'true');
    assert.equal(f.nodes.confirmation.hidden, true);
  }
  f.input('modelPort', '19788');
  f.click('save');
  assert.match(f.nodes.message.textContent, /不能相同/);
  assert.equal(f.focus, 'modelPort');
  f.click('confirm');
  f.render(status());
  f.input('modelPort', '1');
  f.input('managementPort', '0');
  f.click('save');
  assert.match(f.nodes.message.textContent, /浏览器管理端口.*整数/);
  assert.deepEqual(f.calls, []);
});

test('浏览器禁用的管理端口在预览前报错，不发送写请求', () => {
  const f = setup();
  f.render(status());
  for (const value of ['6000', '6667', '10080']) {
    f.input('managementPort', value);
    f.click('save');
    assert.match(f.nodes.message.textContent, new RegExp(`浏览器禁止访问管理端口 ${value}`));
    assert.equal(f.focus, 'managementPort');
    assert.equal(f.nodes.managementPort['aria-invalid'], 'true');
    assert.equal(f.nodes.confirmation.hidden, true);
    f.click('confirm');
  }
  f.render(status({ managementPort: 6000, managementLocked: true }));
  f.input('modelPort', '30200');
  f.click('save');
  assert.match(f.nodes.message.textContent, /6000.*调整 BRIDGE_MANAGEMENT_PORT/);
  assert.equal(f.nodes.confirmation.hidden, true);
  assert.deepEqual(f.calls, []);
});

test('另一页面先提交后，显示冲突并保留草稿，重新确认采用最新端口对', async () => {
  const f = setup();
  f.render(status());
  f.input('modelPort', '30200');
  f.click('save');
  f.reply = () => textResult('端口设置已更新，请核对最新端口后重新确认。', true);
  f.read = () => status({ managementPort: 30300 });
  await f.click('confirm');
  assert.match(f.nodes.message.textContent, /核对最新端口后重新确认/);
  assert.equal(f.nodes.modelPort.value, '30200');
  assert.equal(f.nodes.managementPort.value, '30300');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].arguments.expectedManagementPort, 19788);
  f.click('save');
  f.reply = () => textResult('已保存');
  f.read = () => status({ modelPort: 30200, managementPort: 30300 });
  await f.click('confirm');
  assert.deepEqual(f.calls[1].arguments, { modelPort: 30200, managementPort: 30300, expectedModelPort: 19787, expectedManagementPort: 30300 });
  assert.match(f.nodes.message.textContent, /已应用/);
});

test('确认摘要可取消，轮询改变生效端口或用户继续输入后需重新确认', () => {
  const f = setup();
  f.render(status());
  f.input('modelPort', '30200');
  f.click('save');
  assert.match(f.nodes.preview.textContent, /30200.*19788/);
  assert.equal(f.focus, 'cancel');
  f.click('cancel');
  assert.equal(f.focus, 'save');
  f.click('confirm');
  f.click('save');
  f.render(status({ managementPort: 30300 }));
  assert.equal(f.nodes.confirmation.hidden, true);
  f.click('confirm');
  f.click('save');
  f.input('modelPort', '30202');
  f.click('confirm');
  assert.deepEqual(f.calls, []);
  assert.equal(f.reads, 0);
});

test('仅确认后提交整数边界值，在途去重，最终用宿主推送核实并清除已保存草稿', async () => {
  const f = setup(), reply = Promise.withResolvers(), refreshed = Promise.withResolvers();
  f.reply = () => reply.promise;
  f.read = () => refreshed.promise;
  f.render(status());
  f.input('modelPort', '1');
  f.input('managementPort', '65535');
  f.click('save');
  f.render(status());
  assert.equal(f.nodes.confirmation.hidden, false);
  const task = f.click('confirm');
  f.click('save'); f.click('confirm');
  assert.equal(f.nodes.managementPort.disabled, true);
  assert.equal(f.reads, 0);
  assert.deepEqual(f.calls, [{ method: 'tools/call', name: 'bridge_set_ports', arguments: {
    modelPort: 1, managementPort: 65535, expectedModelPort: 19787, expectedManagementPort: 19788,
  } }]);
  reply.resolve(textResult(status()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads, 1);
  f.click('confirm');
  f.render(status({ modelPort: 1, managementPort: 65535 }));
  refreshed.resolve();
  await task;
  assert.match(f.nodes.message.textContent, /已应用.*1.*65535/);
  assert.equal(f.nodes.save.disabled, true);
  f.render(status({ modelPort: 40000 }));
  assert.equal(f.nodes.modelPort.value, '40000');
  assert.equal(f.calls.length, 1);
});

test('保存错误仍查最终状态，已知冲突和格式错误可定位，原始诊断内容不会外泄', async () => {
  const f = setup();
  f.render(status());
  f.input('managementPort', '35900');
  const errors = [
    [textResult({ reason: 'EADDRINUSE token=private' }, true), /占用.*空闲端口/],
    [textResult('回环端口 35900 已被占用或没有监听权限。token=private', true), /浏览器管理端口 35900.*占用或没有监听权限/],
    [textResult('旧端口记录已保留，未能确认原服务已恢复。请检查权限和端口后重试启动。', true), /旧端口记录已保留.*可能尚未恢复/],
    [textResult('模型端口与管理端口不能相同 secret', true), /不能相同/],
    [textResult('端口必须介于 1 和 65535 token=private', true), /1 到 65535.*整数/],
    [textResult('未知错误 <img src=x> secret', true), /检查代理状态/],
    [Error('结果未知 secret'), /通信未完成/],
  ];
  for (const [error, expected] of errors) {
    f.reply = () => { if (error instanceof Error) throw error; return error; };
    f.click('save');
    await f.click('confirm');
    assert.match(f.nodes.message.textContent, expected);
    assert.doesNotMatch(f.nodes.message.textContent, /secret|private|<img/);
    assert.equal(f.nodes.managementPort.value, '35900');
    assert.equal(f.nodes.save.disabled, false);
  }
  assert.equal(f.reads, errors.length);
  assert.equal(f.calls.length, errors.length);
});

test('代理暂停时确认端口已保存，并显示最终快照中的未就绪状态', async () => {
  const f = setup();
  f.render(status());
  f.input('managementPort', '32088');
  f.click('save');
  f.read = () => ({ ...status({ managementPort: 32088 }), autoRecoveryPaused: true, ready: false });
  await f.click('confirm');
  assert.match(f.nodes.message.textContent, /已保存.*尚未就绪.*32088/);
  assert.equal(f.nodes.save.disabled, true);
});

test('成功文本无法替代最终快照，读取失败、无推送与端口不符均保留草稿', async () => {
  const f = setup();
  f.render(status());
  f.input('modelPort', '39100');
  f.reply = () => textResult(status({ modelPort: 39100 }));
  for (const [read, expected] of [
    [() => { throw Error('secret'); }, /刷新状态/],
    [() => undefined, /刷新状态/],
    [() => status(), /当前生效.*19787.*19788/],
  ]) {
    f.read = read;
    f.click('save');
    await f.click('confirm');
    assert.match(f.nodes.message.textContent, expected);
    assert.doesNotMatch(f.nodes.message.textContent, /已应用|secret/);
    assert.equal(f.nodes.modelPort.value, '39100');
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.reads, 3);
});

test('销毁解绑控件，晚到写入不触发刷新，晚到刷新不再更新界面', async () => {
  for (const duringRead of [false, true]) {
    const f = setup(), late = Promise.withResolvers();
    if (duringRead) f.read = () => late.promise;
    else f.reply = () => late.promise;
    f.render(status());
    f.input('modelPort', '39100');
    f.click('save');
    const task = f.click('confirm');
    await new Promise(resolve => setImmediate(resolve));
    f.panel.dispose();
    const before = f.nodes.message.textContent;
    late.resolve(duringRead ? status({ modelPort: 39100 }) : textResult('已应用'));
    await task;
    f.render(status());
    f.click('confirm');
    assert.equal(f.calls.length, 1);
    assert.equal(f.reads, Number(duringRead));
    assert.equal(f.nodes.message.textContent, before);
  }
});
