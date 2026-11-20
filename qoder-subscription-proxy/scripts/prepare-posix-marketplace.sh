#!/bin/sh
# 从源码复制独立本地市场；与通用 ZIP 共用入口和分发清单。
set -eu

# 将失败原因写入 stderr 并终止准备。
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
[ ! -L "$market_root/.qoder-plugin" ] && [ -f "$catalog" ] && [ ! -L "$catalog" ] || fail '源码仓库缺少常规 .qoder-plugin/marketplace.json；请从原仓库运行此脚本。'

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

# 只清理本次成功 mkdir 后拥有的目录；完成时清空 owned 以保留成品。
owned=
cleanup() {
    if [ -n "$owned" ]; then rm -rf "$owned"; fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
mkdir "$target" || fail '无法创建目标目录（可能已被创建）；未覆盖任何已有目标。'
owned=$target
copy_root="$target/qoder-subscription-proxy"
mkdir "$target/.qoder-plugin" "$copy_root" "$copy_root/.qoder-plugin" "$copy_root/assets" "$copy_root/server" "$copy_root/server/bin" "$copy_root/server/panel" "$copy_root/scripts"

# 仅复制清单中的普通文件；所有目标目录均由本次创建，源目录逐层拒绝链接。
copy_file() {
    relative=$1
    case "/$relative/" in *//*|*/../*|*/./*|*\\*|*:*) fail "无效的分发路径：$relative" ;; esac
    source="$plugin_root/$relative"
    [ -f "$source" ] && [ ! -L "$source" ] || fail "分发文件缺失或是符号链接：$relative"
    cp "$source" "$copy_root/$relative"
}
for directory in .qoder-plugin assets server server/bin server/panel scripts; do
    [ -d "$plugin_root/$directory" ] && [ ! -L "$plugin_root/$directory" ] || fail "分发目录缺失或是符号链接：$directory"
done

# 保留市场登记信息、顶层 README 与许可证，插件 README 的相对引用在副本中仍可使用。
cp "$catalog" "$target/.qoder-plugin/marketplace.json"
for market_file in README.md LICENSE; do
    [ -f "$market_root/$market_file" ] && [ ! -L "$market_root/$market_file" ] || fail "市场分发文件缺失或是符号链接：$market_file"
    cp "$market_root/$market_file" "$target/$market_file"
done

# 插件仅按白名单复制；通用 mcp.json 字节不变，准备市场无需执行解释器或取得核心。
list="$plugin_root/scripts/distribution-files.txt"
[ -f "$list" ] && [ ! -L "$list" ] || fail '缺少常规文件 scripts/distribution-files.txt'
while IFS= read -r relative || [ -n "$relative" ]; do
    copy_file "$relative"
done < "$list"
owned=

printf '已生成独立本地市场：%s\n' "$target"
printf '市场 ID：axing-qoder-plugins；插件：qoder-subscription-proxy。\n'
printf '未自动注册、安装或启用；Qoder Desktop 可在扩展 → 插件中导入通用 ZIP。\n'
