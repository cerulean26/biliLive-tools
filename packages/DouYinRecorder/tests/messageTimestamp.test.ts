import { describe, it, expect } from "vitest";

import { resolveTimestamp } from "../src/messageTimestamp";

/**
 * 时间戳归一化的单一入口。
 *
 * 背景：抖音各消息的时间字段单位不一致（chat 秒、screenChat 纳秒、room/rank/pk 的
 * createTime 秒/毫秒混用），且 `toJSON()` 后都是字符串 —— `"0"` 是 truthy，
 * 用真值判断挡不住。旧写法 `Number(x ?? 0)` 会把「缺失」折成合法的 0，
 * 再经 `0 * 1000` 得到 `ts="0"`，节点静默排到时间线最前。
 */
const NOW = 1_700_000_999_000;

describe("resolveTimestamp:: 不可用值一律回落到 now", () => {
  const cases: [string, string | number | undefined][] = [
    ["undefined", undefined],
    ["空字符串", ""],
    ['字符串 "0"', "0"],
    ["数字 0", 0],
    ["非数字字符串", "abc"],
    ["NaN", Number.NaN],
    ["负数", -1],
  ];

  for (const [label, raw] of cases) {
    it(`${label} → now`, () => {
      expect(resolveTimestamp(raw, { useServerTimestamp: true, now: NOW })).toBe(NOW);
    });
  }

  it("useServerTimestamp 为 false 时即使有值也用 now", () => {
    expect(resolveTimestamp("1700000000", { useServerTimestamp: false, now: NOW })).toBe(NOW);
  });
});

describe("resolveTimestamp:: 单位换算", () => {
  it("ms（默认）：秒级自动 ×1000", () => {
    expect(resolveTimestamp("1700000000", { useServerTimestamp: true, now: NOW })).toBe(
      1_700_000_000_000,
    );
  });

  it("ms（默认）：毫秒级原样使用，不被二次放大", () => {
    expect(resolveTimestamp("1700000000000", { useServerTimestamp: true, now: NOW })).toBe(
      1_700_000_000_000,
    );
  });

  it("ms（默认）：数字类型同样适用", () => {
    expect(resolveTimestamp(1_700_000_000_000, { useServerTimestamp: true, now: NOW })).toBe(
      1_700_000_000_000,
    );
  });

  it("s：强制按秒解释", () => {
    expect(resolveTimestamp("1700000000", { useServerTimestamp: true, unit: "s", now: NOW })).toBe(
      1_700_000_000_000,
    );
  });

  it("ns：纳秒 ÷1e6 得毫秒", () => {
    expect(
      resolveTimestamp("1700000000000000000", { useServerTimestamp: true, unit: "ns", now: NOW }),
    ).toBe(1_700_000_000_000);
  });
});

describe("resolveTimestamp:: now 的取值", () => {
  it("未传 now 时取 Date.now()", () => {
    const before = Date.now();
    const out = resolveTimestamp(undefined, { useServerTimestamp: true });

    expect(out).toBeGreaterThanOrEqual(before);
    expect(out).toBeLessThanOrEqual(Date.now());
  });
});
