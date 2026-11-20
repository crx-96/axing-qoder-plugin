/** 为一个已插入的更新区绑定控件。readStatus 复用宿主查询，可返回快照或通过 render 推送快照。 */
const createUpdatePanel = function createUpdatePanel({ request, readStatus, root = document.querySelector('#core-update') }) {
  /** 片段中的固定节点，只在当前根节点内查找。 */
  const ui = Object.fromEntries(Array.from(root.querySelectorAll('[data-part]'), node => [node.dataset.part, node]));
  /** 由服务端报告的下载阶段。 */
  const phases = { waiting: '等待下载', downloading: '正在下载', verifying: '正在校验', installing: '正在安装' };
  /** 此实例最近一次收到的公共状态。 */
  let snapshot;
  /** 本地在途操作，包含工具结束后的最终状态读取。 */
  let action = '';
  let requestedVersion = '';
  /** 确认区绑定的具体版本，快照变更时重新要求确认。 */
  let candidate = null;
  /** 当前操作失败或读取失败的提示。 */
  let notice = '';
  /** 同一打开周期只消费一次自动检查机会。 */
  let initialized = false;
  /** 销毁后忽略在途请求的回调。 */
  let disposed = false;
  /** 等待下一次状态读取的单次定时器。 */
  let timer = null;
  /** 已开始的轮询，用于确保操作收尾读取的是完成后的快照。 */
  let polling = null;

  /** 从权威快照展示当前版本、候选版本和服务端进度。 */
  function paint() {
    const { state, version, reason, progress } = snapshot?.update || {};
    const busy = Boolean(action) || busyState(state);
    const messages = {
      idle: '尚未检查更新。', checking: '正在检查更新…', current: '已是最新版本。',
      available: `发现新版 ${version || ''}。`, downloading: `正在准备新版 ${version || ''}，当前版本可继续使用。`,
      staged: `新版 ${version || ''} 已就绪，可稍后切换。`, switching: `正在切换到 ${version || '新版'}，核心将短暂重启。`,
      error: '更新遇到问题。', custom: '正在使用自定义核心。',
    };
    // 命令刚发出时给出即时反馈。一旦服务端进入新阶段，就展示实际状态。
    let display = state;
    if (action === 'download' && state === 'available') display = 'downloading';
    if (action === 'apply' && state === 'staged') display = 'switching';
    if (action === 'check' && !busyState(state)) display = 'checking';
    ui.running.textContent = `当前选用版本：${snapshot?.core?.version || '尚未选择'}`;
    ui.tag.disabled = ui.specified.disabled = !initialized || busy || state === 'custom' || !state;
    const specifiedInstalled = snapshot?.installedVersions?.some(entry => entry.version === requestedVersion);
    if (action === 'specified' || (state === 'downloading' && snapshot.update.source === 'specified')) {
      const tag = state === 'downloading' ? version : requestedVersion;
      ui.message.textContent = `正在准备指定版本 ${tag}，当前选版保持不变。`;
    } else {
      const receipt = specifiedInstalled && !action ? `指定版本 ${requestedVersion} 已列入「已安装版本」。` : '';
      ui.message.textContent = receipt + (messages[display] || '更新状态不可用。');
    }
    ui.reason.textContent = notice || (typeof reason === 'string' ? reason : '');
    ui.reason.hidden = !ui.reason.textContent;
    ui.check.disabled = !initialized || busy || !['idle', 'current', 'available', 'staged', 'error'].includes(state);
    ui.download.hidden = state !== 'available' || !version;
    ui.download.disabled = busy;
    ui.switch.hidden = state !== 'staged' || !version;
    ui.switch.disabled = busy;
    if (busy || state !== 'staged' || candidate !== version) candidate = null;
    ui.confirmation.hidden = !candidate;
    ui.switch.setAttribute('aria-expanded', String(Boolean(candidate)));

    // 未知总量用无界进度条；字节和百分比均来自同一个服务端快照。
    ui.meter.hidden = state !== 'downloading' || !progress;
    if (!ui.meter.hidden) {
      const { receivedBytes, totalBytes } = progress;
      const received = Number.isSafeInteger(receivedBytes) && receivedBytes >= 0;
      const bounded = received && Number.isSafeInteger(totalBytes) && totalBytes > 0;
      const amount = received ? ` · ${receivedBytes.toLocaleString()} 字节` : '';
      ui.amount.textContent = (phases[progress.phase] || '正在准备') + amount + (bounded ? ` / ${totalBytes.toLocaleString()} 字节（${Math.min(100, Math.floor(receivedBytes / totalBytes * 100))}%）` : '');
      if (bounded) {
        ui.bar.max = totalBytes;
        ui.bar.value = Math.min(receivedBytes, totalBytes);
      } else ui.bar.removeAttribute('value');
    }
  }

  /** 重开页面也应持续观察已经开始的后台操作。 */
  function busyState(state) { return ['checking', 'downloading', 'switching'].includes(state); }

  /** 统一走宿主的 bridge_status 去重入口，支持宿主通过 render 分发结果。 */
  async function refresh() {
    const status = await readStatus();
    if (status?.update) render(status);
  }

  /** 按需轮询；慢查询返回后再计时，终态或销毁时释放定时器。 */
  function schedule() {
    const needed = !disposed && (['download', 'specified', 'apply'].includes(action) || busyState(snapshot?.update?.state));
    if (!needed) {
      clearTimeout(timer);
      timer = null;
    } else if (timer === null && !polling) {
      timer = setTimeout(async () => {
        timer = null;
        polling = refresh();
        try { await polling; }
        catch { if (!disposed) { notice = '暂时无法读取更新进度，正在重试。'; paint(); } }
        finally { polling = null; schedule(); }
      }, 1200);
    }
  }

  /** 接收主面板每次成功读取的状态；更新期间的轮询也使用同一路径。 */
  function render(status) {
    if (disposed) return;
    if (status?.update?.state !== snapshot?.update?.state || notice === '暂时无法读取更新进度，正在重试。') notice = '';
    snapshot = status;
    paint();
    schedule();
  }

  /** 发起一次互斥工具调用；仅信任状态查询判断是否已经切换或下载完成。 */
  async function run(kind, version) {
    if (disposed || action) return;
    action = kind;
    requestedVersion = kind === 'specified' ? version : '';
    notice = '';
    paint();
    schedule();
    let failure = '';
    try {
      const name = kind === 'specified' ? 'bridge_download_version' : `bridge_${kind}_update`;
      const timeout = ['download', 'specified'].includes(kind) ? 11 * 60_000 : kind === 'apply' ? 120_000 : 30_000;
      const result = await request('tools/call', { name, arguments: version ? { version } : {} }, timeout);
      if (result?.isError) {
        const raw = result.content?.[0]?.text;
        let reason = raw;
        try { reason = JSON.parse(raw)?.reason; } catch { /* 宿主也可直接返回安全原因文本。 */ }
        throw Error(typeof reason === 'string' && reason ? reason : '更新操作失败。');
      }
    } catch (error) { failure = error?.message || '更新请求失败。'; }
    // 即便工具报错，也重新核对后台真实状态，不从工具返回值推断成功。
    try {
      if (polling) await polling.catch(() => {});
      if (!disposed) await refresh();
    } catch { failure ||= '无法读取更新状态，请刷新状态。'; }
    if (disposed) return;
    action = '';
    if (failure) requestedVersion = '';
    notice = failure;
    paint();
    schedule();
  }

  /** 只接受当前可见且可用的操作；二次确认绑定到仍然就绪的同一版本。 */
  function click(event) {
    const button = event.target.closest('button[data-part]');
    if (!button || button.disabled || button.hidden || action || disposed || !initialized) return;
    const { state, version } = snapshot?.update || {};
    switch (button.dataset.part) {
      case 'check': return run('check');
      case 'download': if (state === 'available' && version) return run('download', version); break;
      case 'specified': {
        const input = ui.tag.value.trim();
        if (!/^v?(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(input)) {
          notice = '请输入三段数字的版本号，例如 v0.1.4582。';
          paint(); ui.tag.focus(); return;
        }
        return run('specified', input.startsWith('v') ? input : `v${input}`);
      }
      case 'switch':
        if (state !== 'staged' || !version) return;
        candidate = version;
        paint();
        ui.cancel.focus();
        break;
      case 'cancel':
        if (!candidate) return;
        candidate = null;
        paint();
        ui.switch.focus();
        break;
      case 'confirm': if (state === 'staged' && candidate && candidate === version) return run('apply', version); break;
    }
  }

  /** 每次打开在首次有效快照上初始化；后台操作、自定义核心及就绪版本保留原状态。 */
  function initialize(status) {
    if (disposed || initialized || !status?.update) return;
    initialized = true;
    render(status);
    if (!ui.check.disabled) return run('check');
  }

  /** 页面关闭时解绑并使晚到的工具结果失效；后台下载可在重开后观察。 */
  function dispose() {
    disposed = true;
    schedule();
    root.removeEventListener('click', click);
  }
  root.addEventListener('click', click);
  return { render, initialize, dispose };
};
