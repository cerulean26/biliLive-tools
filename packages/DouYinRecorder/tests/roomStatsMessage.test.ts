import { describe, it, expect, vi } from "vitest";
import { buildRoomStatsMessage } from "../src/index";

/**
 * `room_stats` 消息构造的护栏 —— 测试 `src/index.ts` 的真实实现。
 *
 * 这层纯函数存在的理由：`saveRoomStats` 开关原先埋在 `client.on("roomStats")`
 * 回调里，无法被单测覆盖（与 `saveGiftDanma` 一样只能人工验）。
 * 抽出来后，「开关关闭不产消息」才成为可断言的不变量。
 *
 * ⚠️ 覆盖边界：本文件只覆盖纯函数。调用点里
 * `save: this.saveRoomStats !== false` 这一行（开关接入）仍是未覆盖的，
 * 它复制自 `linkMic` 的 `this.savePk === false` 写法。
 */

describe("buildRoomStatsMessage:: 保存开关", () => {
  it("save 为 false 时返回 null（关闭后 XML 里不会出现 <room>）", () => {
    const out = buildRoomStatsMessage(
      { displayValue: "12345", common: { createTime: "1700000000" } },
      { useServerTimestamp: true, save: false },
    );

    expect(out).toBeNull();
  });

  it("save 缺省时视为开启（既有调用方不受影响）", () => {
    const out = buildRoomStatsMessage({ displayValue: "12345" }, { useServerTimestamp: false });

    expect(out).not.toBeNull();
  });
});

describe("buildRoomStatsMessage:: 人数取值口径", () => {
  it("displayValue 缺失时返回 null", () => {
    const out = buildRoomStatsMessage(
      { common: { createTime: "1700000000" } },
      { useServerTimestamp: true },
    );

    expect(out).toBeNull();
  });

  it("displayValue 为空串时返回 null", () => {
    const out = buildRoomStatsMessage({ displayValue: "" }, { useServerTimestamp: true });

    expect(out).toBeNull();
  });

  it("数值型 displayValue 统一转成字符串（int64 不走 number）", () => {
    const out = buildRoomStatsMessage({ displayValue: 12345 }, { useServerTimestamp: true });

    expect(out?.online).toBe("12345");
    expect(typeof out?.online).toBe("string");
  });

  it("产出的消息 type 是 room_stats", () => {
    const out = buildRoomStatsMessage({ displayValue: "1" }, { useServerTimestamp: false });

    expect(out?.type).toBe("room_stats");
  });
});

describe("buildRoomStatsMessage:: 时间戳口径", () => {
  it("useServerTimestamp 关闭时用本地时间", () => {
    const now = 1_700_000_005_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const out = buildRoomStatsMessage({ displayValue: "100" }, { useServerTimestamp: false });

      expect(out?.timestamp).toBe(now);
    } finally {
      spy.mockRestore();
    }
  });

  it("useServerTimestamp 开启 + 秒级 createTime 时换算成毫秒", () => {
    const out = buildRoomStatsMessage(
      { displayValue: "100", common: { createTime: "1700000000" } },
      { useServerTimestamp: true },
    );

    expect(out?.timestamp).toBe(1_700_000_000_000);
  });

  it("useServerTimestamp 开启 + 毫秒级 createTime 时原样使用（不被二次 ×1000）", () => {
    const out = buildRoomStatsMessage(
      { displayValue: "100", common: { createTime: 1_700_000_000_000 } },
      { useServerTimestamp: true },
    );

    expect(out?.timestamp).toBe(1_700_000_000_000);
  });

  it("createTime 缺失时不产出 NaN 时间戳", () => {
    const out = buildRoomStatsMessage({ displayValue: "100" }, { useServerTimestamp: true });

    expect(Number.isNaN(out?.timestamp as number)).toBe(false);
  });
});
