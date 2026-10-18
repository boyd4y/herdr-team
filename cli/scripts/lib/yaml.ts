/**
 * 元数据文件的读写。
 *
 * 元数据现在独立成文件（`.role.yaml` / `.task.yaml`），不再内嵌在 Markdown 里 ——
 * 所以这里只负责「一个平坦映射 ⇄ 块状 YAML」，不需要 frontmatter 那套切分和重组。
 */

const KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"]);

/** 可以直接裸写的普通标量：字母或中文开头，其后只含安全字符。 */
const SAFE_PLAIN = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff._ -]*$/;

const YAML = (Bun as unknown as { YAML: { parse(input: string): unknown } }).YAML;

/** 输出一个 YAML 标量。宁可多引号，也不要写出去被解析成别的类型。 */
export function scalar(value: string): string {
  if (value === "") return '""';
  if (KEYWORDS.has(value.toLowerCase())) return JSON.stringify(value);
  // 数字开头会被 YAML 当数字 —— id "0001" 就是典型受害者
  if (/^[0-9]/.test(value)) return JSON.stringify(value);
  if (SAFE_PLAIN.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * 写一个值。布尔和数字要**裸写** —— 走 scalar() 会把 `true` 变成字符串 `"true"`，
 * 读回来就不等于 `true` 了。
 */
function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return scalar(String(value));
}

/**
 * 把一个平坦映射写成块状 YAML（不含 `---` 围栏 —— 元数据文件本身就是 YAML）。
 * `order` 里的键按给定顺序排在前面，其余键保持原顺序跟在后面。
 */
export function emitYaml(data: Record<string, unknown>, order: string[] = []): string {
  const known = order.filter((k) => data[k] !== undefined);
  const rest = Object.keys(data).filter((k) => data[k] !== undefined && !order.includes(k));
  const lines: string[] = [];

  for (const key of [...known, ...rest]) {
    const value = data[key];
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => literal(v)).join(", ")}]`);
    } else if (value !== null && typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${literal(v)}`);
      }
    } else {
      lines.push(`${key}: ${literal(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** 解析元数据文件。不是映射时返回 null。 */
export function parseYaml(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
