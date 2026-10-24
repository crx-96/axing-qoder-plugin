#!/bin/sh
# 从源码生成独立 POSIX 本地市场；不注册市场、不安装插件、不修改已有缓存。
set -eu

# 错误和用法写入 stderr；任何输入路径都作为单独参数处理，绝不 eval。
fail() {
    printf 'qoder-subscription-proxy: %s\n' "$1" >&2
    exit 1
}

# 源市场必须是本脚本所在插件的仓库父目录，避免猜测或读取已安装缓存。
[ "$#" -eq 1 ] && [ -n "$1" ] || fail '用法：sh qoder-subscription-proxy/scripts/prepare-posix-marketplace.sh <不存在的目标目录>（父目录须已存在）'
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || fail '无法解析脚本目录。'
plugin_root=$(CDPATH= cd -P "$script_dir/.." && pwd) || fail '无法解析插件目录。'
market_root=$(CDPATH= cd -P "$plugin_root/.." && pwd) || fail '无法解析源码市场目录。'
catalog="$market_root/.qoder-plugin/marketplace.json"
[ -f "$catalog" ] && [ ! -L "$catalog" ] || fail '源码仓库缺少 .qoder-plugin/marketplace.json；请从原仓库运行此脚本。'

# 先规范化已有父目录，拦截源仓库内目标及符号链接别名；不创建额外父目录。
# 将相对路径加 ./，使以连字符开头的名称不会被 dirname/basename 当作选项。
requested=$1
case "$requested" in /*) ;; *) requested="./$requested" ;; esac
while [ "${requested%/}" != "$requested" ]; do requested=${requested%/}; done
[ -n "$requested" ] || fail '目标不能是文件系统根目录。'
name=$(basename "$requested")
case "$name" in ''|.|..) fail '目标必须是新的独立目录。' ;; esac
parent=$(CDPATH= cd -P "$(dirname "$requested")" && pwd) || fail '目标的父目录不存在或不可访问，请先创建父目录。'
target="$parent/$name"
case "$target/" in
    "$market_root/"*) fail '目标不能位于源码仓库内；请使用独立目录。' ;;
    */.qoder/cli/plugins/cache/*|*/.qoder-cn/cli/plugins/cache/*|*/.qoder/plugins/cache/*|*/.qoder-cn/plugins/cache/*) fail '目标不能位于已安装插件缓存内。' ;;
esac
[ ! -e "$target" ] && [ ! -L "$target" ] || fail '目标已存在，拒绝覆盖；请选择新的目录。'

# 只删除本次成功 mkdir 后拥有的目录；失败或中断不留下半成品市场。
# 已有目录绝不进入清理范围；成功后清空 owned，保留正式交付目录。
owned=
cleanup() {
    if [ -n "$owned" ]; then rm -rf "$owned"; fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
mkdir "$target" || fail '无法创建目标目录（可能已被创建）；未覆盖任何已有目标。'
owned=$target
copy_root="$target/qoder-subscription-proxy"
mkdir "$target/.qoder-plugin" "$copy_root" "$copy_root/.qoder-plugin" "$copy_root/bridge" "$copy_root/bridge/bin" "$copy_root/bridge/panel" "$copy_root/scripts"

# 仅复制显式允许的常规文件；拒绝符号链接文件和目录，防止引用外部真实数据。
# 参数为插件内相对路径，目标同名；目录已由本脚本创建。
copy_file() {
    relative=$1
    source="$plugin_root/$relative"
    [ -f "$source" ] && [ ! -L "$source" ] || fail "分发文件缺失或是符号链接：$relative"
    cp "$source" "$copy_root/$relative"
}
for directory in .qoder-plugin bridge bridge/bin bridge/panel scripts; do
    [ -d "$plugin_root/$directory" ] && [ ! -L "$plugin_root/$directory" ] || fail "分发目录缺失或是符号链接：$directory"
done

# 顶层 allowlist 不包含默认 Windows 清单、测试、data、临时目录或未知文件。
# 市场 JSON 原样复制，保持 axing-qoder-plugins ID、版本和展示元数据不变。
cp "$catalog" "$target/.qoder-plugin/marketplace.json"
# 插件 README 的 ../README.md 链接仍指向市场说明，并保留市场自身许可证。
for market_file in README.md LICENSE; do
    [ -f "$market_root/$market_file" ] && [ ! -L "$market_root/$market_file" ] || fail "市场分发文件缺失或是符号链接：$market_file"
    cp "$market_root/$market_file" "$target/$market_file"
done
for relative in .qoder-plugin/plugin.json .mcp.posix.json README.md LICENSE DISCLAIMER.md THIRD_PARTY_NOTICES.md Antigravity授权.cmd; do
    copy_file "$relative"
done

# bridge 根目录只允许 JavaScript 源文件；不递归复制 bridge/data 或其他目录。
for source_file in "$plugin_root"/bridge/*.mjs; do
    copy_file "bridge/$(basename "$source_file")"
done
# 核心只保留来源清单、原始文档与许可证；即使源码旁仍有旧二进制也不复制。
# MCP 启动后后台校验并缓存当前平台核心，打包过程不联网。
for relative in bridge/panel/LICENSE bridge/panel/management.upstream.html bridge/bin/LICENSE bridge/bin/README.md bridge/bin/README_CN.md bridge/bin/config.example.yaml bridge/bin/platforms.json; do
    copy_file "$relative"
done

# Windows CLI 授权脚本仍作为原项目可选能力保留，不移植为 Unix CLI 助手。
# Unix 用户通过现有网页授权；这里只包含明确已知的脚本和托管入口。
for script in antigravity-login.ps1 image-preview.ps1 mcp-server.mjs proxy-supervisor.ps1 proxy-supervisor.mjs ProxyJob.cs start-mcp.ps1 start-mcp.sh prepare-posix-marketplace.sh; do
    copy_file "scripts/$script"
done
cp "$copy_root/.mcp.posix.json" "$copy_root/.mcp.json"
owned=

# 仅提示手动安装入口；本脚本不读写用户全局配置或 Qoder 已安装缓存。
printf '已生成 macOS/Linux 独立本地市场：%s\n' "$target"
printf '市场 ID：axing-qoder-plugins；插件：qoder-subscription-proxy。\n'
printf '此目录供支持自定义市场的客户端使用；Qoder Desktop 请从源码用 package-plugin.mjs posix 生成 ZIP，再在扩展 → 插件中上传。\n'
printf '未自动注册、安装或启用；若已存在同 ID 市场，请在界面确认市场来源。源目录和已安装缓存未修改，未复制真实 data。\n'
