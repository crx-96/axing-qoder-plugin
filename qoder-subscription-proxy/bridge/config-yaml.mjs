/** 语法错误不得回显可能包含凭据的输入。 */
function unsupportedYaml() {
  return new Error("config.yaml 结构不受支持或存在重复字段；请使用标准 v8 缩进映射、单行标量和块列表，不使用锚点、合并、标签、流式集合或多行标量。");
}

function readYamlScalar(raw) {
  const quoted = raw.match(/^("(?:[^"\\]|\\.)*")(?:[ ]+#.*)?$/);
  if (quoted) {
    try {
      return JSON.parse(quoted[1]);
    } catch {
      throw unsupportedYaml();
    }
  }
  const single = raw.match(/^'((?:[^']|'')*)'(?:[ ]+#.*)?$/);
  if (single) return single[1].replace(/''/g, "'");
  const plain = raw.replace(/[ ]+#.*$/, "").trimEnd();
  if (/^(?:0|[1-9][0-9]*)$/.test(plain)) return Number(plain);
  if (plain === "true" || plain === "false") return plain === "true";
  // 空集合保持原终值语义，不展开流式集合。
  if (plain === "[]" || plain === "{}" || plain === "null" || plain === "~") return null;
  if (!/^[A-Za-z0-9_/.\\$][A-Za-z0-9_/.\\$:+@%#=\-]*$/.test(plain) || plain.endsWith(":")) {
    throw unsupportedYaml();
  }
  return plain;
}

/** 键先解码再判重；引号内冒号和 GJSON 条件不是映射分隔符。 */
function readEntry(content) {
  const entry = content.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[a-z][a-z0-9.-]*):(?: +(.*))?$/);
  if (!entry) return null;
  const key = entry[1].startsWith('"') || entry[1].startsWith("'") ? readYamlScalar(entry[1]) : entry[1];
  if (key === "<<" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(key)) throw unsupportedYaml();
  return { key, raw: entry[2] };
}

// 保留源码位置以定向插入配置，不重建或丢弃用户的其他配置与注释。
export function parseConfigYaml(text) {
  if (typeof text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) {
    throw unsupportedYaml();
  }
  const lines = text.split(/\r?\n/);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const values = new Map();
  const nodes = new Map();
  const stack = [];
  /** 解析栈的路径/判重状态与对外源码节点分离，避免暴露内部状态。 */
  function pushNode(path, line, indent, childIndent, kind, raw) {
    const node = { line, end: lines.length, indent, childIndent, kind, raw };
    nodes.set(JSON.stringify(path), node);
    const frame = { path, node, keys: new Set() };
    stack.push(frame);
    return frame;
  }
  pushNode([], -1, -1, 0, "map", undefined);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = (lineNumber === 0 ? lines[lineNumber].replace(/^\uFEFF/, "") : lines[lineNumber]).trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t") || line.includes("\r")) throw unsupportedYaml();
    let indent = line.length - line.trimStart().length;
    let content = line.slice(indent);
    const isList = content.startsWith("- ");
    // 无额外缩进列表仍属于字段容器；标量及映射项不能借此接纳子元素。
    while (stack.length > 1) {
      const top = stack.at(-1).node;
      if (indent > top.indent || (indent === top.indent && isList && top.kind !== "map" && top.raw === undefined)) break;
      stack.pop().node.end = lineNumber;
    }
    let parent = stack.at(-1);
    if (parent.node.raw !== undefined) throw unsupportedYaml();
    if (parent.node.childIndent === null) parent.node.childIndent = indent;
    if (parent.node.childIndent !== indent) throw unsupportedYaml();
    const kind = isList ? "list" : "map";
    if (parent.node.kind && parent.node.kind !== kind) throw unsupportedYaml();
    parent.node.kind = kind;
    if (isList) {
      const parentKey = JSON.stringify(parent.path);
      if (!values.has(parentKey)) values.set(parentKey, []);
      const items = values.get(parentKey);
      const prefixLength = content.match(/^- +/)[0].length;
      const item = content.slice(prefixLength);
      const itemPath = [...parent.path, items.length];
      if (!readEntry(item)) {
        const value = readYamlScalar(item);
        items.push(value);
        values.set(JSON.stringify(itemPath), value);
        pushNode(itemPath, lineNumber, indent, null, null, item);
        continue;
      }
      items.push(null);
      parent = pushNode(itemPath, lineNumber, indent, indent + prefixLength, "map", undefined);
      indent += prefixLength;
      content = item;
    }
    const entry = readEntry(content);
    if (!entry || parent.keys.has(entry.key)) throw unsupportedYaml();
    parent.keys.add(entry.key);
    // 路径片段不点拼接，防止顶层含点键或列表项冒充安全字段。
    const path = [...parent.path, entry.key];
    const raw = entry.raw === undefined || entry.raw.startsWith("#") ? undefined : entry.raw;
    pushNode(path, lineNumber, indent, null, null, raw);
    if (raw !== undefined) values.set(JSON.stringify(path), readYamlScalar(raw));
  }
  return { values, nodes, lines, newline };
}
