/** 语法错误不得回显可能包含凭据的输入。 */
function unsupportedYaml() {
  return new Error("config.yaml 结构不受支持或存在重复字段；请使用标准 v8 缩进映射、单行标量、|- 文字块和块列表，支持单行内联集合，不使用锚点、别名、合并、标签、多文档或折叠标量。");
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
  // 空集合保持既有终值契约，非空集合由结构解析器展开。
  if (plain === "[]" || plain === "{}" || plain === "null" || plain === "~") return null;
  // 冒号分隔符与开头的 YAML 指示符不能伪装成普通字符串。
  if (!plain || /^[\s!&*{}\[\],#|>"'%@`]/.test(plain) || /^[-?:](?:\s|$)/.test(plain) ||
      /:(?:\s|$)/.test(plain) || /^(?:---|\.\.\.)(?:\s|$)/.test(plain)) {
    throw unsupportedYaml();
  }
  return plain;
}

/** 核心保存时会去掉 GJSON 键的引号；仍将选择器视为完整键并在解码后判重。 */
function readEntry(content) {
  const entry = content.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*(?:#(?:\([^:#]*\)\.[A-Za-z0-9_.-]+)?)?):(?: +(.*))?$/);
  if (!entry) return null;
  const key = entry[1].startsWith('"') || entry[1].startsWith("'") ? readYamlScalar(entry[1]) : entry[1];
  if (key === "<<" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(key)) throw unsupportedYaml();
  return { key, raw: entry[2] };
}

/** 单行递归下降保留值的列范围，避免引号内分隔符和嵌套集合被误拆。 */
function readFlow(raw) {
  let cursor = 0;
  const spaces = () => { while (raw[cursor] === " ") cursor++; };
  function read(depth = 0, allowEmpty = false) {
    if (depth > 100) throw unsupportedYaml();
    spaces();
    const start = cursor;
    const opening = raw[cursor];
    if (opening === "[" || opening === "{") {
      const kind = opening === "[" ? "list" : "map";
      const closing = kind === "list" ? "]" : "}";
      const children = [];
      const keys = new Set();
      cursor++;
      spaces();
      while (raw[cursor] !== closing) {
        let key = children.length;
        if (kind === "map") {
          const match = raw.slice(cursor).match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:[\]{},]+) *:/);
          if (!match) throw unsupportedYaml();
          const entry = readEntry(match[1] + ":");
          if (!entry || keys.has(entry.key)) throw unsupportedYaml();
          key = entry.key;
          keys.add(key);
          cursor += match[0].length;
          // 裸键后必须有分隔符，避免把含冒号的普通词误判为映射。
          if (!/^["']/.test(match[1]) && raw[cursor] && !/[ ,{}\[\]]/.test(raw[cursor])) throw unsupportedYaml();
        }
        const child = read(depth + 1, kind === "map");
        children.push([key, child]);
        spaces();
        if (raw[cursor] === closing) break;
        if (raw[cursor++] !== ",") throw unsupportedYaml();
        spaces();
      }
      cursor++;
      return { kind, children, start, end: cursor, raw: raw.slice(start, cursor) };
    }
    if (opening === '"' || opening === "'") {
      const match = raw.slice(cursor).match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/);
      if (!match) throw unsupportedYaml();
      cursor += match[0].length;
    } else {
      while (cursor < raw.length && !/[\[\]{},]/.test(raw[cursor])) {
        if (raw[cursor] === "#" && (cursor === start || raw[cursor - 1] === " ")) break;
        cursor++;
      }
    }
    const token = raw.slice(start, cursor).trimEnd();
    if (!token && !allowEmpty) throw unsupportedYaml();
    return { kind: null, value: token ? readYamlScalar(token) : null, start, end: start + token.length, raw: token };
  }
  const tree = read();
  if (!/^(?: +#.*| *)$/.test(raw.slice(cursor))) throw unsupportedYaml();
  return tree;
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
  function readValue(path, node, raw) {
    if (!/^[\[{]/.test(raw)) {
      const value = readYamlScalar(raw);
      values.set(JSON.stringify(path), value);
      return value;
    }
    const tree = readFlow(raw);
    const base = lines[node.line].trimEnd().length - raw.length;
    function register(branch, branchPath, target) {
      const key = JSON.stringify(branchPath);
      target.flow = { start: base + branch.start, end: base + branch.end, kind: branch.kind };
      target.kind = branch.children?.length ? branch.kind : null;
      if (!branch.kind) {
        values.set(key, branch.value);
        return branch.value;
      }
      const items = [];
      for (const [part, child] of branch.children) {
        const childPath = [...branchPath, part];
        const childNode = { line: node.line, end: node.line + 1, indent: node.indent, childIndent: null, kind: null, raw: child.raw };
        nodes.set(JSON.stringify(childPath), childNode);
        items.push(register(child, childPath, childNode));
      }
      // 与块式一致：映射项以 null 占位，内容只能通过分段路径读取。
      const value = branch.kind === "list" && items.length ? items : null;
      if (branch.kind === "list" || !items.length) values.set(key, value);
      return value;
    }
    return register(tree, path, node);
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
        const frame = pushNode(itemPath, lineNumber, indent, null, null, item);
        items.push(readValue(itemPath, frame.node, item));
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
        readValue(path, frame.node, raw);
      }
    }
  }
  return { values, nodes, lines, newline, literalRows };
}

function encodeScalar(value) {
  return JSON.stringify(value)?.replace(/[\u007f-\u009f\u2028\u2029]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** 仅把待插入内容编码为 flow，原文件的同行兄弟、注释和换行不参与重排。 */
function renderFlow(parsed, path) {
  const key = JSON.stringify(path);
  const node = parsed.nodes.get(key);
  if (!node) throw unsupportedYaml();
  const kind = node.kind ?? node.flow?.kind;
  if (kind === "map" || kind === "list") {
    const parts = [];
    for (const childKey of parsed.nodes.keys()) {
      const child = JSON.parse(childKey);
      if (child.length !== path.length + 1 || !path.every((part, i) => part === child[i])) continue;
      const value = renderFlow(parsed, child);
      parts.push(kind === "map" ? `${JSON.stringify(child.at(-1))}: ${value}` : value);
    }
    return kind === "map" ? `{${parts.join(", ")}}` : `[${parts.join(", ")}]`;
  }
  return encodeScalar(parsed.values.get(key) ?? null);
}

/** 在给定映射或列表末尾插入 render(indent) 返回的 YAML，同时补齐缺失祖先、保留相邻注释和换行。 */
export function appendConfigBlock(parsed, path, kind, render) {
  let parent = parsed.nodes.get("[]");
  // 沿真实路径检查已存在的祖先，遇到不兼容类型时拒绝重写。
  let depth = 0;
  for (; depth < path.length; depth++) {
    const node = parsed.nodes.get(JSON.stringify(path.slice(0, depth + 1)));
    if (!node) break;
    const expectedKind = depth === path.length - 1 ? kind : (typeof path[depth + 1] === "number" ? "list" : "map");
    const empty = node.raw?.replace(/\s+#.*$/, "").trim();
    const allowedEmpty = [undefined, "", "null", "~", expectedKind === "list" ? "[]" : "{}"];
    if (node.kind !== expectedKind && node.flow?.kind !== expectedKind && !(node.kind === null && allowedEmpty.includes(empty))) {
      throw new Error(`config.yaml 的 ${path.join(".")} 必须为标准映射或相应的列表。`);
    }
    parent = node;
  }

  const lines = [...parsed.lines];
  if (parent.flow) {
    const addition = parseConfigYaml("addition:\n" + render(2));
    const addedNode = addition.nodes.get('["addition"]');
    if (addedNode?.kind !== kind) throw unsupportedYaml();
    let rendered = renderFlow(addition, ["addition"]);
    for (let i = path.length - 1; i >= depth; i--) rendered = `{${JSON.stringify(path[i])}: ${rendered}}`;
    const { start, end, kind: flowKind } = parent.flow;
    const row = lines[parent.line];
    if (flowKind) {
      const existing = row.slice(start + 1, end - 1).trimEnd();
      const separator = !existing.trim() || existing.endsWith(",") ? "" : ",";
      lines[parent.line] = row.slice(0, start + 1) + existing + separator + " " + rendered.slice(1, -1) + row.slice(end - 1);
    } else {
      lines[parent.line] = row.slice(0, start) + rendered + row.slice(end);
    }
    const updated = lines.join(parsed.newline);
    parseConfigYaml(updated);
    return updated.endsWith(parsed.newline) ? updated : updated + parsed.newline;
  }

  // 将显式空容器展开为块映射或列表，保留行末注释及其原缩进。
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

/** 定点替换单行标量，接受字符串、布尔值及安全整数；缺失、集合和多行值均拒绝写入。 */
export function replaceConfigScalar(text, path, value, { allowNull = false } = {}) {
  const parsed = parseConfigYaml(text);
  const key = JSON.stringify(path);
  const node = parsed.nodes.get(key);
  const before = parsed.values.get(key);
  // 迁移可选配置时允许空值；凭据调用方仍要求既有标量。输出编码与普通替换一致。
  const nullable = Number.isSafeInteger(value) || (allowNull && ["boolean", "string"].includes(typeof value));
  const encoded = encodeScalar(value);
  if (node?.kind === null && node.raw === undefined && nullable) {
    const row = parsed.lines[node.line];
    const trimmed = row.trimEnd();
    const comment = readEntry(trimmed.trimStart())?.raw;
    const end = (comment ? trimmed.slice(0, -comment.length).trimEnd() : trimmed).length;
    parsed.lines[node.line] = row.slice(0, end) + " " + encoded + row.slice(end);
    return parsed.lines.join(parsed.newline);
  }
  // 显式 null 和 ~ 同样可迁移，空列表或映射仍按结构错误处理。
  const explicitNull = nullable && (/^(?:null|~)(?: +#.*)?$/.test(node?.raw ?? "") || (node?.flow && node.raw === ""));
  if ((!node?.raw && !explicitNull) || node.kind !== null || node.raw.startsWith("|") ||
      (!explicitNull && !["string", "number", "boolean"].includes(typeof before)) ||
      !(["string", "boolean"].includes(typeof value) || Number.isSafeInteger(value))) throw unsupportedYaml();

  if (before === value) return text;
  const row = parsed.lines[node.line];
  // flow 值之后可能还有兄弟字段，不能从行末反推起点。
  const token = node.raw.match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/)?.[0] ?? node.raw.replace(/ +#.*$/, "").trimEnd();
  const offset = node.flow?.start ?? (row.replace(/ +$/, "").length - node.raw.length);
  const end = node.flow?.end ?? (offset + token.length);
  parsed.lines[node.line] = row.slice(0, offset) + encoded + row.slice(end);
  return parsed.lines.join(parsed.newline);
}
