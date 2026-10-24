#!/bin/sh
# macOS/Linux 的 stdio 入口；由清单显式调用 sh，不依赖脚本执行位。
set -eu

# 输出只写 stderr，避免破坏 MCP 的逐行 JSON-RPC stdout。
fail() {
    printf 'qoder-subscription-proxy: %s\n' "$1" >&2
    exit 1
}

# 入口路径以脚本本身为准，不依赖宿主的工作目录或安装缓存位置。
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || fail '无法解析插件脚本目录。'
entry="$script_dir/mcp-server.mjs"
[ -f "$entry" ] || fail '缺少 scripts/mcp-server.mjs，请重新生成或安装插件。'

# 仅接受已提供原生核心的系统与架构；Git Bash 不是正式支持的平台。
system=$(uname -s) || fail '无法识别操作系统。'
machine=$(uname -m) || fail '无法识别 CPU 架构。'
case "$system" in Darwin|Linux) ;; *) fail '此入口仅支持 macOS/Linux；Windows 请使用默认清单。' ;; esac
case "$machine" in x86_64|arm64|aarch64) ;; *) fail '此入口仅支持 x64/arm64 架构。' ;; esac

# 对每个候选执行真实 Node 能力探测。Electron 必须确实进入 Node 模式，
# 同时验证 Node 主版本 >=22；捕获探测输出并断开其 stdin，保留 MCP 管道。
# 参数 1 为完整可执行路径，参数 2 为 electron 或 node。
try_runtime() {
    candidate=$1
    mode=$2
    [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
    probe='const major = Number(process.versions.node?.split(".")[0]); const electron = Boolean(process.versions.electron); if (!Number.isInteger(major) || major < 22 || electron !== (process.argv[1] === "electron")) process.exit(1); process.stdout.write("qoder-node-runtime-ok");'
    if [ "$mode" = electron ]; then
        result=$(ELECTRON_RUN_AS_NODE=1 "$candidate" -e "$probe" "$mode" </dev/null 2>/dev/null) || return 1
    else
        result=$("$candidate" -e "$probe" "$mode" </dev/null 2>/dev/null) || return 1
    fi
    [ "$result" = qoder-node-runtime-ok ] || return 1

    # exec 让运行时直接继承原 stdin/stdout 和 PID；不额外创建管道或后台进程。
    if [ "$mode" = electron ]; then
        ELECTRON_RUN_AS_NODE=1
        export ELECTRON_RUN_AS_NODE
    fi
    exec "$candidate" "$entry"
}

# 只识别进程实际可执行文件；不解析或执行 ps 的任意命令行内容。
# macOS 限定主应用路径，避免把 Helper 当作可复用的 Qoder 主程序。
try_ancestor() {
    executable=$1
    case "$system:$executable" in
        Darwin:*/Qoder.app/Contents/MacOS/Qoder|Darwin:*/Qoder\ CN.app/Contents/MacOS/Qoder\ CN|Linux:*/Qoder|Linux:*/qoder|Linux:*/Qoder\ CN|Linux:*/qoder-cn)
            try_runtime "$executable" electron || : ;;
        Darwin:*/node|Linux:*/node)
            try_runtime "$executable" node || : ;;
    esac
}

# 沿当前进程祖先查找已启动的 Qoder/真实 Node；限深并检测重复 PID，
# 避免进程结束、权限限制或异常父链导致无界循环。
pid=$$
seen=' '
depth=0
while [ "$depth" -lt 128 ]; do
    case "$pid" in ''|*[!0-9]*|0) break ;; esac
    case "$seen" in *" $pid "*) break ;; esac
    seen="$seen$pid "
    depth=$((depth + 1))
    executable=
    parent=
    if [ "$system" = Linux ]; then
        executable=$(readlink "/proc/$pid/exe" 2>/dev/null) || executable=
        # proc status 的 PPid 是单个十进制值；仅读取，不 source/eval 文件。
        if [ -r "/proc/$pid/status" ]; then
            while IFS=' 	' read -r key value rest; do
                if [ "$key" = 'PPid:' ]; then parent=$value; break; fi
            done < "/proc/$pid/status"
        fi
    else
        executable=$(/bin/ps -p "$pid" -o comm= 2>/dev/null) || executable=
    fi
    [ -z "$executable" ] || try_ancestor "$executable"
    # macOS 没有 procfs；Linux 的 procfs 不可读时也可以只回退查询父 PID。
    if [ -z "$parent" ]; then
        parent=$(/bin/ps -p "$pid" -o ppid= 2>/dev/null | tr -d '[:space:]') || parent=
    fi
    pid=$parent
done

# 宿主祖先不可用时允许 PATH 中的真实 Node，但绝不假定它映射内置运行时。
node_path=$(command -v node 2>/dev/null) || node_path=
[ -z "$node_path" ] || try_runtime "$node_path" node || :

# 有界的标准安装候选只作为最后回退，仍执行同样的版本和 Electron 探测。
# 不扫描整个磁盘，也不修改 PATH、配置或宿主环境。
if [ "$system" = Darwin ]; then
    for application in 'Qoder' 'Qoder CN'; do
        try_runtime "/Applications/$application.app/Contents/MacOS/$application" electron || :
        if [ -n "${HOME:-}" ]; then
            try_runtime "$HOME/Applications/$application.app/Contents/MacOS/$application" electron || :
        fi
    done
else
    for installed in /opt/Qoder/Qoder /opt/Qoder/qoder /opt/qoder/Qoder /opt/qoder/qoder '/opt/Qoder CN/Qoder CN' /opt/qoder-cn/qoder-cn; do
        try_runtime "$installed" electron || :
    done
fi
fail '没有可用的 Node.js 22+ 运行时。请在 Qoder 桌面内启动此插件（内置 Node 也须 >=22），或提供 PATH 中的 Node.js 22+。未修改系统 PATH 或配置。'
