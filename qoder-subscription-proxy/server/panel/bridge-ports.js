/* global blockedManagementPorts */
/** 绑定内联端口面板。宿主负责请求与轮询，readStatus 可返回快照或通过 render 推送。 */
const createPortPanel = function createPortPanel({ request, readStatus, root = document.querySelector('#bridge-ports') }) {
  /** 仅在本实例根节点内查找静态控件。 */
  const ui = Object.fromEntries(Array.from(root.querySelectorAll('[data-part]'), node => [node.dataset.part, node]));
  /** 每个字段对应的快照键、环境覆盖标志和校验提示名称。 */
  const fields = [
    { key: 'modelPort', lock: 'modelLocked', label: '模型端口' },
    { key: 'managementPort', lock: 'managementLocked', label: '浏览器管理端口' },
  ];
  /** 只记录用户改动的原始输入，包括空值；暂时被环境覆盖时保留草稿。 */
  const drafts = new Map();
  /** 最近一次可信的生效端口与锁状态；数据缺失时禁止写入。 */
  let ports = null;
  /** 最近快照的核心就绪标志，可缺省；区分配置已保存与代理已开始服务。 */
  let ready;
  /** 每次 render 递增，用于区分宿主推送了最终快照和读取失败后返回空值。 */
  let revision = 0;
  /** 等待用户确认的整数参数；修改草稿或生效配置会使这次确认失效。 */
  let candidate = null;
  /** 包含保存及最终状态查询的整个互斥区间。 */
  let saving = false;
  /** 页面回收后丢弃所有异步结果。 */
  let disposed = false;

  /** 端口限定为 TCP 可使用的正整数。 */
  function validPort(value) { return Number.isInteger(value) && value >= 1 && value <= 65535; }

  /** 以固定文本反馈，轮询时避免重复播报同一消息。 */
  function message(text, error = false) {
    ui.message.dataset.error = String(error);
    if (ui.message.textContent !== text) ui.message.textContent = text;
  }

  /** 将已知失败转换为安全的中文处理提示，不展示原始异常、路径或凭据。 */
  function failureReason(raw, submitted) {
    let reason = raw;
    try { reason = JSON.parse(raw)?.reason; } catch { /* MCP 也可直接返回普通文本。 */ }
    if (typeof reason === 'string') {
      if (/端口设置已更新/.test(reason)) return '端口设置已更新，请核对最新端口后重新确认。';
      if (/浏览器禁止访问管理端口/.test(reason)) return `浏览器禁止访问管理端口 ${submitted.managementPort}，请选择其他端口。`;
      if (/无法认证原实例的两个端口/.test(reason)) return '无法认证原实例的两个端口，请核对会话端口设置后重试。当前服务已保留。';
      if (/核心切换尚待恢复/.test(reason)) return '核心切换尚待恢复，请先完成核心启停再更改端口。';
      if (/相同|重复|必须不同/.test(reason)) return '模型端口和浏览器管理端口不能相同，请修改其中一个。';
      // 后端的回环监听探测不能区分占用与权限问题，只显示本次提交中匹配的字段和端口。
      const bind = /回环端口 (\d{1,5}) 已被占用或没有监听权限/.exec(reason);
      if (bind) {
        const field = fields.find(({ key }) => submitted[key] === Number(bind[1]));
        const port = field ? `${field.label} ${submitted[field.key]}` : '指定端口';
        return `${port} 已被占用或没有监听权限，请选择其他空闲端口。`;
      }
      if (/未能确认原服务已恢复/.test(reason)) return '旧端口记录已保留，原服务可能尚未恢复。请检查权限和端口后重试启动。';
      if (/原核心不可用于重启/.test(reason)) return '原核心不可用于重启，当前服务已保留。请检查核心状态。';
      if (/EADDRINUSE|占用|address already in use/i.test(reason)) return '端口已被其他服务占用，请选择空闲端口后重试。';
      if (/环境变量|环境覆盖|PORT_LOCKED/.test(reason)) return '端口由环境变量指定。请检查对应的环境变量，再刷新状态。';
      if (/65535|端口.*(?:整数|无效|范围|格式)/.test(reason)) return '端口必须是 1 到 65535 的整数，请检查输入后重试。';
      if (/权限|EACCES|EPERM/.test(reason)) return '权限不足，请检查端口绑定和本地配置的写入权限。';
      if (/重启|启动失败/.test(reason)) return '代理未能完成重启，请检查核心状态和端口占用情况。';
      if (/超时|结果未知|连接|timeout/i.test(reason)) return '与宿主的通信未完成，请刷新状态确认实际端口。';
    }
    return '端口设置未能确认，请检查代理状态和本地端口后重试。';
  }

  /** 同步可操作状态及确认区。输入仅在需要回填时更新，保留编辑光标和未完成的数字。 */
  function paint() {
    let changed = false;
    for (const { key, lock } of fields) {
      const input = ui[key];
      const locked = ports?.[lock] === true;
      ui[lock].hidden = !locked;
      input.disabled = !ports || locked || saving;
      if (!ports) continue;
      const value = locked || !drafts.has(key) ? String(ports[key]) : drafts.get(key);
      if (input.value !== value) input.value = value;
      if (!locked && value !== String(ports[key])) changed = true;
    }
    ui.defaults.disabled = !ports || saving || (ports.modelLocked && ports.managementLocked);
    ui.save.disabled = !changed || saving || Boolean(candidate);
    ui.confirmation.hidden = !candidate;
    ui.save.setAttribute('aria-expanded', String(Boolean(candidate)));
  }

  /** 读取权威配置。只有发生真实的端口或锁变化才作废用户正在看的确认摘要。 */
  function render(status) {
    if (disposed) return;
    revision++;
    ready = status?.ready;
    const next = status?.ports;
    root.hidden = !next;
    if (!fields.every(({ key, lock }) => validPort(next?.[key]) && typeof next?.[lock] === 'boolean')) {
      ports = candidate = null;
      message('无法读取当前端口，请刷新状态。', true);
    } else {
      if (fields.some(({ key, lock }) => ports?.[key] !== next[key] || ports?.[lock] !== next[lock])) {
        if (!saving) message(candidate ? '当前端口设置已更新，请核对后重新确认。' : '');
        for (const { key } of fields) ui[key].removeAttribute('aria-invalid');
        candidate = null;
      }
      ports = next;
    }
    paint();
  }

  /** 手动编辑和恢复默认共用草稿语义；改回当前值后该字段重新跟随快照。 */
  function setDraft(key, value) {
    if (value === String(ports[key])) drafts.delete(key);
    else drafts.set(key, value);
  }

  /** 任一输入变化即撤销待确认的参数和旧校验提示。 */
  function edited(event) {
    const key = event.target.dataset.part;
    if (!ports || saving || !fields.some(field => field.key === key) || ui[key].disabled) return;
    candidate = null;
    setDraft(key, ui[key].value);
    for (const field of fields) ui[field.key].removeAttribute('aria-invalid');
    message('');
    paint();
  }

  /** 构造用户可核对的参数；逐字段提示错误，冲突时把焦点放到可编辑的输入。 */
  function review() {
    const values = {};
    for (const { key, label } of fields) {
      const value = ui[key].value;
      if (!/^\d+$/.test(value) || !validPort(Number(value))) {
        ui[key].setAttribute('aria-invalid', 'true');
        message(`${label}必须是 1 到 65535 的十进制整数。`, true);
        ui[key].focus();
        return;
      }
      values[key] = Number(value);
    }
    if (values.modelPort === values.managementPort) {
      const input = ports.managementLocked ? ui.modelPort : ui.managementPort;
      input.setAttribute('aria-invalid', 'true');
      message('模型端口和浏览器管理端口不能相同，请修改其中一个。', true);
      input.focus();
      return;
    }
    // 只限制需要浏览器访问的管理端口，旧记录仍可手动迁到可用端口。
    if (blockedManagementPorts.includes(values.managementPort)) {
      ui.managementPort.setAttribute('aria-invalid', 'true');
      const advice = ports.managementLocked ? '请调整 BRIDGE_MANAGEMENT_PORT。' : '请选择其他端口。';
      message(`浏览器禁止访问管理端口 ${values.managementPort}，${advice}`, true);
      if (!ports.managementLocked) ui.managementPort.focus();
      return;
    }
    // 仅格式变化（例如前导零）不需要重启代理。
    if (fields.every(({ key }) => values[key] === ports[key])) {
      message('输入的端口已生效，无需保存。');
      return;
    }
    // 固定预览时的原值，提交后由服务端在锁内比较，避免覆盖另一页面刚保存的端口。
    candidate = { ...values, expectedModelPort: ports.modelPort, expectedManagementPort: ports.managementPort };
    ui.preview.textContent = `确认将模型端口设为 ${values.modelPort}、浏览器管理端口设为 ${values.managementPort}？`;
    message('');
    paint();
    ui.cancel.focus();
  }

  /** 仅提交已确认的一对端口。即使写入失败也读取最终状态，禁止自动重试写入。 */
  async function apply() {
    const submitted = candidate;
    candidate = null;
    saving = true;
    message('正在保存并应用端口，代理可能短暂重启…');
    paint();
    let error = '';
    try {
      const result = await request('tools/call', { name: 'bridge_set_ports', arguments: submitted }, 120_000);
      if (result?.isError) error = failureReason(result.content?.find(item => typeof item?.text === 'string')?.text, submitted);
    } catch (cause) { error = failureReason(cause?.message, submitted); }
    if (disposed) return;

    // 有的宿主在 readStatus 内分发 render 并自行处理读取异常，因此还要核实是否收到了新快照。
    const before = revision;
    try {
      const status = await readStatus();
      if (status) render(status);
    } catch { /* 下方统一提示无法核实，保留已取得的具体写入错误。 */ }
    if (disposed) return;
    saving = false;
    if (revision === before || !ports) {
      message(`${error}尚未读取到最终端口，请刷新状态确认。`, true);
    } else if (error) {
      message(error, true);
    } else if (fields.every(({ key }) => submitted[key] === ports[key])) {
      for (const { key, lock } of fields) if (!ports[lock]) drafts.delete(key);
      const saved = ready === false ? '设置已保存，代理尚未就绪。' : '端口设置已应用。';
      message(`${saved}模型端口为 ${ports.modelPort}，浏览器管理端口为 ${ports.managementPort}。`);
    } else {
      message(`当前生效的模型端口为 ${ports.modelPort}，浏览器管理端口为 ${ports.managementPort}。请核对输入后再应用。`, true);
    }
    paint();
  }

  /** 显式按钮分别处理恢复、预览、取消和提交；禁用及迟到的操作不发出请求。 */
  function click(event) {
    const button = event.target.closest('button[data-part]');
    if (!button || button.disabled || disposed || saving || !ports) return;
    switch (button.dataset.part) {
      case 'defaults':
        candidate = null;
        for (const { key, lock } of fields) {
          if (!ports[lock]) setDraft(key, ui[key].defaultValue);
          ui[key].removeAttribute('aria-invalid');
        }
        message('已填入可编辑端口的默认值。');
        paint();
        break;
      case 'save': return review();
      case 'cancel':
        if (!candidate) return;
        candidate = null;
        paint();
        ui.save.focus();
        break;
      case 'confirm': if (candidate) return apply(); break;
    }
  }

  /** 解除本实例监听，关闭后不发起收尾请求，也不回写晚到的状态。 */
  function dispose() {
    disposed = true;
    root.removeEventListener('input', edited);
    root.removeEventListener('click', click);
  }
  root.addEventListener('input', edited);
  root.addEventListener('click', click);
  return { render, dispose };
};
