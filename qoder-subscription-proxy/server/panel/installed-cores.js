/** 管理页内联脚本。宿主提供空 section 和共用的 MCP 请求、状态刷新入口。 */
const createInstalledCoresPanel = function createInstalledCoresPanel({ root, request, readStatus }) {
  const doc = root.ownerDocument;
  /** 只用 DOM 文本节点展示服务端值，使用宿主按钮主题与默认可换行布局。 */
  function element(tag, text) {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    return node;
  }
  const title = element('h2', '已安装版本');
  const list = element('ul');
  const notice = element('p');
  notice.setAttribute('role', 'status');
  root.replaceChildren(title, list, notice);
  /** 最近的版本列表与服务端忙碌目标；确认绑定具体操作及版本。 */
  let versions = [], update = {}, confirmation = null;
  /** 避免重复提交及销毁后的异步回写。 */
  let busy = false, disposed = false, signature = '';

  /** 仅闲置版本允许操作，切换事务期间禁止本面板再提交。 */
  function available(row) {
    return !busy && !row.active && update.state !== 'custom' && update.state !== 'switching' && !(update.state === 'downloading' && update.version === row.version);
  }
  /** 生成可聚焦的原生按钮，焦点键用于刷新后恢复原控件。 */
  function button(text, version, kind, enabled, callback) {
    const node = element('button', text);
    node.type = 'button';
    node.dataset.focus = `${version}-${kind}`;
    node.disabled = !enabled;
    node.addEventListener('click', callback);
    return node;
  }
  /** 绘制行和行内确认，将焦点移至取消或原按钮，其他状态更新保留已有焦点。 */
  function paint(focus = doc.activeElement?.dataset?.focus) {
    const rows = [];
    for (const row of versions) {
      const { version, sizeBytes, active } = row;
      const item = element('li');
      item.style.overflowWrap = 'anywhere';
      item.append(element('span', `${version} · ${(sizeBytes / 1048576).toLocaleString(undefined, {maximumFractionDigits: 1})} MiB · ${active ? '当前版本' : '已安装'}`));
      for (const [kind, label] of [['apply', '切换'], ['delete', '删除']]) {
        const trigger = button(label, version, kind, available(row), () => {
          if (disposed || !available(row)) return;
          confirmation = { version, kind };
          notice.textContent = '';
          paint(`${version}-cancel`);
        });
        trigger.setAttribute('aria-label', `${label} ${version}`);
        trigger.setAttribute('aria-expanded', String(confirmation?.version === version && confirmation.kind === kind));
        item.append(doc.createTextNode(' '), trigger);
      }
      if (confirmation?.version === version) {
        const { kind } = confirmation;
        const group = element('div');
        const message = kind === 'apply' ? `切换到 ${version}？运行中的核心将短暂重启。` : `只删除 ${version} 的核心缓存，账号和数据将保留。`;
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', message);
        group.append(element('p', message), button('取消', version, 'cancel', true, () => {
          confirmation = null;
          paint(`${version}-${kind}`);
        }), doc.createTextNode(' '), button(kind === 'apply' ? '确认切换' : '确认删除', version, 'confirm', true, () => run(version, kind)));
        item.append(group);
      }
      rows.push(item);
    }
    list.replaceChildren(...(rows.length ? rows : [element('li', '暂无已安装的发行核心。')]));
    const next = Array.from(list.querySelectorAll('button')).find(node => !node.disabled && node.dataset.focus === focus);
    next?.focus();
  }
  /** 服务端快照使过期确认立即失效，相同轮询结果保留 DOM 和键盘焦点。 */
  function render(status) {
    if (disposed) return;
    versions = Array.isArray(status?.installedVersions) ? status.installedVersions : [];
    update = status?.update || {};
    const current = JSON.stringify([versions, update.state, update.version]);
    if (current === signature) return;
    signature = current;
    if (!versions.some(row => row.version === confirmation?.version && available(row))) confirmation = null;
    paint();
  }
  /** 确认后请求宿主执行并刷新；服务端拥有最终互斥和版本校验权。 */
  async function run(version, kind) {
    if (disposed || confirmation?.kind !== kind || confirmation.version !== version || !versions.some(row => row.version === version && available(row))) return;
    busy = true;
    confirmation = null;
    notice.textContent = '正在处理…';
    paint();
    let message;
    try {
      const name = kind === 'apply' ? 'bridge_apply_update' : 'bridge_delete_version';
      const result = await request('tools/call', { name, arguments: { version } }, 120000);
      if (result?.isError) throw Error(result.content?.[0]?.text || '核心操作失败。');
      message = kind === 'apply' ? `已切换到 ${version}。` : `已删除 ${version}。`;
    } catch (error) { message = error?.message || '核心请求失败。'; }
    try {
      if (!disposed) {
        const status = await readStatus();
        if (status) render(status);
      }
    } catch { message += ' 请刷新以核对当前状态。'; }
    if (disposed) return;
    busy = false;
    notice.textContent = message;
    paint();
  }
  /** 页面卸载后取消本地确认并释放所有监听节点。 */
  function dispose() { disposed = true; root.replaceChildren(); }
  return { render, dispose };
};
