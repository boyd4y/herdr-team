/** Formatting helpers for plain status tables; interactive layout belongs to OpenTUI. */

/** Bun owns Unicode terminal width; Intl segments complete grapheme clusters. */
export function displayWidth(s: string): number { return Bun.stringWidth(s); }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
  for (const { segment: ch } of graphemes.segment(s)) {
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return `${out}${" ".repeat(budget - w)}…`;
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
