import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const testCorePath = process.env.BRIDGE_TEST_BIN || "";
export const nativeCoreSkip = testCorePath ? false : "未设置 BRIDGE_TEST_BIN；原生核心测试跳过，不自动联网下载";

export async function copyTestCore(target) {
  assert.ok(testCorePath, "原生测试必须显式设置 BRIDGE_TEST_BIN");
  assert.ok(isAbsolute(testCorePath), "BRIDGE_TEST_BIN 必须是预先准备的当前平台核心绝对路径");
  assert.notEqual(resolve(target), resolve(testCorePath), "只能复制核心，不能覆盖测试源文件");
  assert.equal((await lstat(testCorePath)).isFile(), true, "BRIDGE_TEST_BIN 必须是普通文件，不能是符号链接");
  await copyFile(testCorePath, target);
  const metadata = JSON.parse(await readFile(new URL("../../bridge/bin/platforms.json", import.meta.url), "utf8"));
  const release = metadata.platforms[`${process.platform}-${process.arch}`];
  assert.ok(release, "原生测试只支持平台清单列出的当前系统与架构");
  assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), release.binarySha256,
    "预先准备的测试核心必须匹配当前平台固定版本 SHA256；不执行错误或未验证文件");
  return target;
}
