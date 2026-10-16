/**
 * 终端显示宽度相关的公共工具。
 *
 * 抽出来的理由：`status.ts` 的表格和 `watch.ts` 的看板必须用**同一套宽度口径**，
 * 各写一份迟早会分叉。`displayWidth` 的字符类就是原来 `status.ts` 里那个，
 * 逐字搬过来的 —— 换掉它等于换掉所有表格的列宽。
 */

/**
 * 宽字符（东亚）判定。
 *
 * **不要加 `g` 标志** —— 带 `g` 的正则 `.test()` 会记住 `lastIndex`，连续调用时
 * 结果随机跳，这种 bug 极难查。
 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠]/;

/** 这段字符串在终端里占几列。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** 补空格到指定显示宽度。已经超过就不动（本函数不截断）。 */
export function padTo(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

/**
 * 按显示宽度截断，超出时以 `…` 结尾。
 *
 * 结果宽度**一定 ≤ width**；截断发生时宽度在 `width-1` 到 `width` 之间
 * （宽字符卡在边界上时宁可少占一格，也不劈半个字或溢出）。需要定宽单元格
 * 就再接一个 `padTo`。
 */
export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;

  const budget = width - 1; // 留一格给省略号
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return `${out}${" ".repeat(budget - w)}…`;
}

/** 硬折一行：优先在空格断，断不了就在宽度边界硬断。 */
function wrapLine(text: string, width: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  let start = 0;

  while (start < chars.length) {
    let w = 0;
    let end = start;
    let lastSpace = -1;

    while (end < chars.length) {
      const ch = chars[end];
      if (ch === undefined) break;
      const cw = WIDE.test(ch) ? 2 : 1;
      if (w + cw > width) break;
      w += cw;
      end += 1;
    }

    // 宽度连一个字符都容不下 —— 硬取一个，否则下面会原地打转。
    if (end === start) end = start + 1;

    // 断点候选只看 `chars[start..limit-1]`。**边界上那个刚好放不下的空格也要算进来** ——
    // 它自己不进行，但「它前面那截正好占满一行」是个合法的断点。漏掉它就会把
    // `"hello world foo"`（宽 11）断成 `["hello", "world foo"]`。
    const limit = end < chars.length && chars[end] === " " ? end + 1 : end;
    for (let i = limit - 1; i >= start; i--) {
      if (chars[i] === " ") {
        lastSpace = i;
        break;
      }
    }

    if (end >= chars.length) {
      out.push(chars.slice(start).join(""));
      break;
    }
    if (lastSpace > start) {
      out.push(chars.slice(start, lastSpace).join(""));
      start = lastSpace + 1;
    } else {
      out.push(chars.slice(start, end).join(""));
      start = end;
    }
  }

  return out;
}

/** 折成若干行；保留原有的换行与空行。 */
export function wrapTo(s: string, width: number): string[] {
  if (width <= 0) return [];
  return s.split("\n").flatMap((line) => (line === "" ? [""] : wrapLine(line, width)));
}

/**
 * 抹掉来自磁盘的字符串里的控制字符。
 *
 * **这是正确性要求，不是讲究。** 卡片元数据和 `task.md` 都是别人写进仓库的，
 * 会被原样写进 raw mode 的终端：一个内嵌的 `\x1b` 就能改掉后续所有输出，
 * 一个 `\r` 能把光标拉回行首覆盖掉已写的内容，一个 `\t` 会让宽度计算全部错位。
 * 任何从磁盘读来的字符串进渲染之前都要过这里。
 *
 * `keepNewlines` 是给正文用的：换行在 `task.md` 里是有意义的结构，不能剥；
 * 但**单行字段（标题/id/角色名…）必须剥掉**，否则一个换行就能凭空多顶出一行，
 * 把整帧撞歪。`\r` 两种模式都剥 —— 它只会搞破坏。
 *
 * 先换 `\t` 再剥控制字符 —— `\t` 自己就是 `\x09`，顺序反了就变成直接删掉。
 */
export function sanitize(s: string, keepNewlines = false): string {
  return s
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (ch) => (keepNewlines && ch === "\n" ? "\n" : ""));
}
