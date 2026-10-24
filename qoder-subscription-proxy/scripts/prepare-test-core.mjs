/** CI 显式准备当前平台核心；普通 node --test 不导入或调用此联网入口。 */
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../bridge/config.mjs";
import { ensureCore } from "../bridge/core-runtime.mjs";

/** 下载到 runner 临时目录并向后续步骤公布测试核心路径，不启动桥或读取用户授权。 */
async function main() {
  /** GitHub 提供的临时目录；必须显式指定，不能回退到用户数据目录。 */
  const runnerTemp = process.env.RUNNER_TEMP;
  /** 当前步骤专属的 GitHub 环境文件；只追加无换行的测试二进制路径。 */
  const githubEnv = process.env.GITHUB_ENV;
  // 先验证 CI 输出位置，避免本地误运行时下载或写入默认环境。
  if (!runnerTemp || !githubEnv || !isAbsolute(runnerTemp) || !isAbsolute(githubEnv)) {
    throw new Error("需要绝对路径 RUNNER_TEMP 和 GITHUB_ENV；此脚本只用于显式 CI 核心准备步骤。");
  }
  /** 仅本步骤创建和拥有的隔离目录，失败后清理；成功由临时 runner 回收。 */
  const directory = await mkdtemp(join(runnerTemp, "subscription-proxy-core-"));
  try {
    /** 源码插件根目录，只用于加载生产配置，不访问已安装插件缓存。 */
    const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    /** 使用固定测试凭据和独立 data，不继承 BRIDGE_BIN 或用户 BRIDGE_* 设置。 */
    const config = await loadConfig({ pluginRoot, env: {
      // 本次 runner 临时缓存与配置位置；不会触碰真实账号目录。
      BRIDGE_DATA_DIR: join(directory, "data"),
      // 固定合成客户端密钥，仅供隔离测试；不是用户凭据。
      BRIDGE_API_KEY: "isolated-ci-core-test-api-key",
      // 保持插件公共管理密码契约，此脚本不会启动管理接口。
      BRIDGE_MGMT_KEY: "123456",
    } });
    // 复用生产下载、双 SHA256 校验与缓存逻辑；失败即终止，不在 CI 包装重试。
    /** 下载器返回可用状态，实际路径固定由 config.binPath 提供。 */
    const result = await ensureCore(config, { allowDownload: true });
    if (!result.available) throw new Error(result.reason || "当前平台测试核心准备失败。");
    if (/[\r\n]/.test(config.binPath)) throw new Error("测试核心路径不能包含换行。");
    // 后续原生测试只能读取此源并复制到各自 fixture；不共享运行数据或启动进程。
    await appendFile(githubEnv, `BRIDGE_TEST_BIN=${config.binPath}\n`, "utf8");
    process.stdout.write(`已准备当前平台 ${process.platform}-${process.arch} 测试核心；未启动代理。\n`);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

await main();
