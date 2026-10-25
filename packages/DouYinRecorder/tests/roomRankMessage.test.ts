import { describe, it, expect } from "vitest";

import { buildRoomRankMessage } from "../src/index";

/**
 * `room_rank` 消息构造的护栏 —— 测试 `src/index.ts` 的真实实现。
 *
 * 抽成纯函数的原因与 `buildRoomStatsMessage` 相同：取数口径与「空榜不产消息」这类不变量
 * 埋在 `client.on("roomRank")` 回调里就没法断言。
 *
 * ⚠️ 覆盖边界：本文件只覆盖纯函数；调用点里 `this.useServerTimestamp ?? false` 那行参数传递
 * 仍是未覆盖的（与 roomStats 一样只能人工验）。
 */

/** 真实 wire 形状：`ranks[].user` 的头像字段是 `AvatarThumb`（首字母大写，proto 原样） */
function rankMsg(users: { id?: string; nickName?: string; uri?: string }[]) {
  return {
    ranks: users.map((u) => ({
      user: {
        ...(u.id === undefined ? {} : { id: u.id }),
        ...(u.nickName === undefined ? {} : { nickName: u.nickName }),
        ...(u.uri === undefined ? {} : { AvatarThumb: { uri: u.uri } }),
      },
    })),
    common: { createTime: "1792908437124" },
  };
}

const AVATAR = "100x100/aweme-avatar/tos-cn-avt-0015_08e62e839eb076980778c931c83a74ce";

describe("buildRoomRankMessage:: 取值与顺序", () => {
  it("数组顺序即名次，字段归一为 uid/nick/avatarUri", () => {
    const out = buildRoomRankMessage(
      rankMsg([
        { id: "97814778350", nickName: "米大王", uri: AVATAR },
        { id: "7630365130980066353", nickName: "神秘人•S" },
        { id: "432566925526460", nickName: "黎嗲域" },
      ]),
      false,
    );

    expect(out).not.toBeNull();
    expect(out?.type).toBe("room_rank");
    // ⚠️ 保序是核心契约：名次完全由这个顺序承载，排序会让「名次互换」永远不可见
    expect(out?.users.map((u) => u.uid)).toEqual([
      "97814778350",
      "7630365130980066353",
      "432566925526460",
    ]);
    expect(out?.users[0].nick).toBe("米大王");
    expect(out?.users[0].avatarUri).toBe(AVATAR);
  });

  it("id 位数不统一时必须原样保留（11/19/15 位实测都出现过，转数字会丢精度）", () => {
    const out = buildRoomRankMessage(
      rankMsg([{ id: "7630365130980066353" }, { id: "97814778350" }, { id: "432566925526460" }]),
      false,
    );

    expect(out?.users[0].uid).toBe("7630365130980066353");
    expect(typeof out?.users[0].uid).toBe("string");
  });

  it("缺 AvatarThumb 时不产出 avatarUri 键（而不是空串）", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1", nickName: "a" }]), false);

    expect(out?.users[0]).not.toHaveProperty("avatarUri");
  });

  it("昵称缺失时退化为空串，由 XSL 侧按 uid 兜底", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), false);

    expect(out?.users[0].nick).toBe("");
  });
});

describe("buildRoomRankMessage:: 不可用输入", () => {
  it("ranks 缺失时返回 null", () => {
    expect(buildRoomRankMessage({ common: { createTime: "1" } }, false)).toBeNull();
  });

  it("ranks 为空数组时返回 null（避免写出空榜节点）", () => {
    expect(buildRoomRankMessage({ ranks: [], common: { createTime: "1" } }, false)).toBeNull();
  });

  it("条目缺 uid 时整条丢弃，其余保留", () => {
    const out = buildRoomRankMessage(
      rankMsg([{ nickName: "无 id" }, { id: "2", nickName: "有 id" }]),
      false,
    );

    expect(out?.users).toHaveLength(1);
    expect(out?.users[0].uid).toBe("2");
  });

  it("全部条目都缺 uid 时返回 null", () => {
    expect(buildRoomRankMessage(rankMsg([{ nickName: "a" }, { nickName: "b" }]), false)).toBeNull();
  });
});

describe("buildRoomRankMessage:: 时间戳口径", () => {
  it("useServerTimestamp 为 true 时毫秒 createTime 直接用", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), true);

    expect(out?.timestamp).toBe(1792908437124);
  });

  it("useServerTimestamp 为 true 时秒级 createTime 乘 1000", () => {
    const out = buildRoomRankMessage(
      { ranks: [{ user: { id: "1" } }], common: { createTime: "1700000000" } },
      true,
    );

    expect(out?.timestamp).toBe(1700000000000);
  });

  it("useServerTimestamp 为 false 时用本地时间", () => {
    const before = Date.now();
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), false);

    expect(out?.timestamp).toBeGreaterThanOrEqual(before);
    expect(out?.timestamp).toBeLessThanOrEqual(Date.now());
  });
});
