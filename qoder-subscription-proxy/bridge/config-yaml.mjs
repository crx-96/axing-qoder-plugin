/** 语法错误不得回显可能包含凭据的输入。 */
function unsupportedYaml() {
  return new Error("config.yaml 结构不受支持或存在重复字段；请使用标准 v8 缩进映射、单行标量、|- 文字块和块列表，不使用锚点、合并、标签、流式集合或折叠标量。");
}

/** 解码受限的单行标量；拒绝不支持的语法且不回显原值。 */
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
  // 负整数用于上游的凭据继承及瞬时冷却开关。
  if (/^(?:0|-?[1-9][0-9]*)$/.test(plain)) return Number(plain);
  if (plain === "true" || plain === "false") return plain === "true";
  // 空集合保持原终值语义，不展开流式集合。
  if (plain === "[]" || plain === "{}" || plain === "null" || plain === "~") return null;
  // 字段内的 * 是核心序列化模型通配符的普通字符；开头的 * 仍作为 YAML 别名拒绝。
  if (!/^[A-Za-z0-9_/.\\$][A-Za-z0-9_/.\\$:+@%#=*\-]*$/.test(plain) || plain.endsWith(":")) {
    throw unsupportedYaml();
  }
  return plain;
}

/** 核心保存时会去掉 GJSON 键的引号；仍将选择器视为完整键并在解码后判重。 */
function readEntry(content) {
  const entry = content.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[a-z][a-z0-9.-]*(?:#(?:\([^:#]*\)\.[a-z0-9.-]+)?)?):(?: +(.*))?$/);
  if (!entry) return null;
  const key = entry[1].startsWith('"') || entry[1].startsWith("'") ? readYamlScalar(entry[1]) : entry[1];
  if (key === "<<" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(key)) throw unsupportedYaml();
  return { key, raw: entry[2] };
}

/** 读取核心序列化的 |- 文字块，按首个非空行去除公共缩进并剥离末尾换行。 */
function readStrippedLiteral(lines, header, indent, literalRows) {
  let contentIndent;
  const body = [];
  let end = header + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    const spaces = line.match(/^ */)[0].length;
    // 纯空行不决定缩进。首行之前超出内容缩进的空白，以及混用缩进的文本，都不能猜测解释。
    if (spaces !== line.length) {
      if (spaces <= indent) break;
      if (contentIndent === undefined) {
        contentIndent = spaces;
        if (body.some(blank => blank.length > spaces)) throw unsupportedYaml();
      }
      if (spaces < contentIndent) {
        if (line.slice(spaces).startsWith("#")) break;
        throw unsupportedYaml();
      }
    }
    body.push(line);
  }
  // 标量内的 # 行也属于值，不得被配置插入器当成相邻段的注释移动。
  for (let i = header + 1; i < end; i++) literalRows.add(i);
  const value = body.map(line => line.slice(contentIndent ?? line.length)).join("\n").replace(/\n+$/, "");
  return { value, end };
}

/** 解析 v8 块式 YAML，保存路径、值、行号和缩进，供安全字段核对与定点迁移复用。 */
export function parseConfigYaml(text) {
  if (typeof text !== "string" || /\r(?!\n)/.test(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) {
    throw unsupportedYaml();
  }
  const lines = text.split(/\r?\n/);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const values = new Map();
  const nodes = new Map();
  const stack = [];
  const literalRows = new Set();
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
    const line = (lineNumber === 0 ? lines[lineNumber].replace(/^\uFEFF/, "") : lines[lineNumber]).replace(/ +$/, "");
    if (/^ *(?:#.*)?$/.test(line)) continue;
    if (line.includes("\t") || line.includes("\r")) throw unsupportedYaml();
    // YAML 的结构缩进只使用 ASCII 空格，不能让 NBSP 等字符制造虚假的嵌套层级。
    let indent = line.match(/^ */)[0].length;
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
    const frame = pushNode(path, lineNumber, indent, null, null, raw);
    if (raw !== undefined) {
      if (/^\|-(?: +#.*)?$/.test(raw)) {
        const literal = readStrippedLiteral(lines, lineNumber, indent, literalRows);
        values.set(JSON.stringify(path), literal.value);
        frame.node.literalEnd = literal.end;
        lineNumber = literal.end - 1;
      } else {
        values.set(JSON.stringify(path), readYamlScalar(raw));
      }
    }
  }
  return { values, nodes, lines, newline, literalRows };
}

/** 在给定映射或列表末尾插入 render(indent) 返回的 YAML，同时补齐缺失祖先、保留相邻注释和换行。 */
export function appendConfigBlock(parsed, path, kind, render) {
  let parent = parsed.nodes.get("[]");
  // 沿真实路径检查已存在的祖先，遇到不兼容类型时拒绝重写。
  let depth = 0;
  for (; depth < path.length; depth++) {
    const node = parsed.nodes.get(JSON.stringify(path.slice(0, depth + 1)));
    if (!node) break;
    const expectedKind = depth === path.length - 1 ? kind : "map";
    const empty = node.raw?.replace(/\s+#.*$/, "").trim();
    const allowedEmpty = [undefined, "null", "~", expectedKind === "list" ? "[]" : "{}"];
    if (node.kind !== expectedKind && !(node.kind === null && allowedEmpty.includes(empty))) {
      throw new Error(`config.yaml 的 ${path.join(".")} 必须为标准映射或相应的列表。`);
    }
    parent = node;
  }

  // 将显式空容器展开为块映射或列表，保留行末注释及其原缩进。
  const lines = [...parsed.lines];
  if (parent.raw !== undefined) {
    lines[parent.line] = lines[parent.line].replace(/(?:\{\}|\[\]|null|~)(\s*(?:#.*)?)$/, "$1").trimEnd();
  }
  let indent = parent.childIndent ?? (parent.indent < 0 ? 0 : parent.indent + 2);
  const added = [];
  for (; depth < path.length; depth++) {
    added.push(`${" ".repeat(indent)}${path[depth]}:`);
    indent += 2;
  }
  added.push(...render(indent).split("\n"));
  // 将同级段之前的注释留在原段前，不插入到注释与其目标之间。
  let insertion = parent.end;
  while (insertion > parent.line + 1 && !parsed.literalRows.has(insertion - 1) && /^\s*(?:#.*)?$/.test(lines[insertion - 1])) insertion--;
  lines.splice(insertion, 0, ...added);
  const updated = lines.join(parsed.newline);
  return updated.endsWith(parsed.newline) ? updated : updated + parsed.newline;
}

/** 定点替换已有的单行字符串或布尔值，仅改写标量本身；缺失、集合和多行值均拒绝写入。 */
export function replaceConfigScalar(text, path, value) {
  const parsed = parseConfigYaml(text);
  const key = JSON.stringify(path);
  const node = parsed.nodes.get(key);
  const before = parsed.values.get(key);
  if (!node?.raw || node.kind !== null || node.raw.startsWith("|") ||
      !["string", "number", "boolean"].includes(typeof before) || !["string", "boolean"].includes(typeof value)) throw unsupportedYaml();

  // 解析过的原始值仍含行末注释；只截取第一个完整标量，允许引号中的空格和 #。
  if (before === value) return text;
  const token = node.raw.match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^ ]+)/)[0];
  const row = parsed.lines[node.line];
  const offset = row.replace(/ +$/, "").length - node.raw.length;
  const encoded = JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  parsed.lines[node.line] = row.slice(0, offset) + encoded + row.slice(offset + token.length);
  return parsed.lines.join(parsed.newline);
}
