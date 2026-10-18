import { describe, expect, test } from "bun:test";
import { displayWidth, sanitize, truncate, wrapTo } from "../scripts/lib/text.ts";

describe("displayWidth", () => {
  test("ASCII 一列、中文两列", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("0015 中文 ok")).toBe(12); // 4 + 1 + 4 + 1 + 2
  });

  test("全角标点算两列，省略号算一列", () => {
    expect(displayWidth("（）")).toBe(4);
    expect(displayWidth("…")).toBe(1);
  });
});

describe("truncate", () => {

  test("宽度容不下时给空串，不给负数格子", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -1)).toBe("");
  });

  /**
   * 宽字符卡在边界上：宁可少占一格，也不许劈半个字、不许溢出。
   * 5 列只能放「中文」(4) + 「…」，剩的第 6 列那种情况会被这里挡住。
   */
  test("宽字符卡边界：补空格而不是劈字", () => {
    expect(truncate("中文中文", 5)).toBe("中文…");
    expect(truncate("中文中文", 4)).toBe("中 …");
    expect(displayWidth(truncate("中文中文", 4))).toBe(4);
  });

  test("任何情况下结果都不超过给定宽度", () => {
    const samples = ["", "a", "中", "中文中文", "ab 中文 cd", "a…b"];
    for (let width = 0; width <= 12; width++) {
      for (const s of samples) {
        expect(displayWidth(truncate(s, width))).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("wrapTo", () => {
  test("优先在空格断", () => {
    expect(wrapTo("hello world foo", 11)).toEqual(["hello world", "foo"]);
  });

  test("中文在宽度边界硬断", () => {
    expect(wrapTo("中文中文", 4)).toEqual(["中文", "中文"]);
  });

  test("保留原有的换行与空行", () => {
    expect(wrapTo("a\n\nb", 10)).toEqual(["a", "", "b"]);
    expect(wrapTo("", 10)).toEqual([""]);
  });

  test("宽度连一个宽字都容不下也不能死循环", () => {
    expect(wrapTo("中", 1)).toEqual(["中"]);
    expect(wrapTo("中文", 1)).toEqual(["中", "文"]);
  });

  test("宽度为 0 时返回空", () => {
    expect(wrapTo("abc", 0)).toEqual([]);
  });
});

describe("sanitize", () => {
  test("剥掉 ESC —— 卡片正文里的转义序列必须是惰性的", () => {
    expect(sanitize("正常\x1b[31m红\x1b[0m")).toBe("正常[31m红[0m");
  });

  test("剥掉 CR：它能把光标拉回行首覆盖已写内容", () => {
    expect(sanitize("a\rb\x00c")).toBe("abc");
  });

  test("Tab 换成四个空格 —— 否则所有宽度计算都错位", () => {
    expect(sanitize("a\tb")).toBe("a    b");
  });

  test("单行字段里换行也要剥掉，否则能凭空顶出一行", () => {
    expect(sanitize("标题\n第二行")).toBe("标题第二行");
  });

  test("正文模式保留换行，但 CR 照样剥", () => {
    expect(sanitize("第一段\n\n第二段", true)).toBe("第一段\n\n第二段");
    expect(sanitize("a\r\nb", true)).toBe("a\nb");
  });
});
