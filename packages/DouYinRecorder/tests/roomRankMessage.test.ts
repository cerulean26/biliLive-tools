import fs from "node:fs";

import { describe, it, expect } from "vitest";

import { buildRoomRankMessage } from "../src/index";

/**
 * `room_rank` 消息构造的护栏 —— 测试 `src/index.ts` 的真实实现。
 *
 * 抽成纯函数的原因与 `buildRoomStatsMessage` 相同：取数口径与「空榜不产消息」这类不变量
 * 埋在 `client.on("roomRank")` 回调里就没法断言。
 *
 * ⚠️ 覆盖边界：纯函数覆盖不到「调用点有没有传对参数」，所以补了一组**源码级护栏**
 * （见文件末尾）：`save` 开关与 `useServerTimestamp` 的接线一旦被删，这里会红。
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
      { useServerTimestamp: false },
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
      { useServerTimestamp: false },
    );

    expect(out?.users[0].uid).toBe("7630365130980066353");
    expect(typeof out?.users[0].uid).toBe("string");
  });

  it("缺 AvatarThumb 时不产出 avatarUri 键（而不是空串）", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1", nickName: "a" }]), {
      useServerTimestamp: false,
    });

    expect(out?.users[0]).not.toHaveProperty("avatarUri");
  });

  it("昵称缺失时退化为空串，由 XSL 侧按 uid 兜底", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), { useServerTimestamp: false });

    expect(out?.users[0].nick).toBe("");
  });
});

describe("buildRoomRankMessage:: 不可用输入", () => {
  it("ranks 缺失时返回 null", () => {
    expect(
      buildRoomRankMessage({ common: { createTime: "1" } }, { useServerTimestamp: false }),
    ).toBeNull();
  });

  it("ranks 为空数组时返回 null（避免写出空榜节点）", () => {
    expect(
      buildRoomRankMessage(
        { ranks: [], common: { createTime: "1" } },
        { useServerTimestamp: false },
      ),
    ).toBeNull();
  });

  it("条目缺 uid 时整条丢弃，其余保留", () => {
    const out = buildRoomRankMessage(
      rankMsg([{ nickName: "无 id" }, { id: "2", nickName: "有 id" }]),
      { useServerTimestamp: false },
    );

    expect(out?.users).toHaveLength(1);
    expect(out?.users[0].uid).toBe("2");
  });

  it("全部条目都缺 uid 时返回 null", () => {
    expect(
      buildRoomRankMessage(rankMsg([{ nickName: "a" }, { nickName: "b" }]), {
        useServerTimestamp: false,
      }),
    ).toBeNull();
  });
});

describe("buildRoomRankMessage:: 开关", () => {
  it("save 为 false 时返回 null（不写 <rank> 节点）", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), {
      useServerTimestamp: false,
      save: false,
    });

    expect(out).toBeNull();
  });

  it("save 缺省时按开启处理（老配置不传该键不影响出数据）", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), { useServerTimestamp: false });

    expect(out).not.toBeNull();
    expect(out?.type).toBe("room_rank");
  });
});

describe("buildRoomRankMessage:: 时间戳口径", () => {
  it("useServerTimestamp 为 true 时毫秒 createTime 直接用", () => {
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), { useServerTimestamp: true });

    expect(out?.timestamp).toBe(1792908437124);
  });

  it("useServerTimestamp 为 true 时秒级 createTime 乘 1000", () => {
    const out = buildRoomRankMessage(
      { ranks: [{ user: { id: "1" } }], common: { createTime: "1700000000" } },
      { useServerTimestamp: true },
    );

    expect(out?.timestamp).toBe(1700000000000);
  });

  it("useServerTimestamp 为 false 时用本地时间", () => {
    const before = Date.now();
    const out = buildRoomRankMessage(rankMsg([{ id: "1" }]), { useServerTimestamp: false });

    expect(out?.timestamp).toBeGreaterThanOrEqual(before);
    expect(out?.timestamp).toBeLessThanOrEqual(Date.now());
  });
});

/**
 * 源码级护栏：纯函数测不到「调用点传了什么」。
 *
 * 曾经的风险点：`save` 只存在于 handler 那一行，若被顺手删掉（或退回旧的
 * `buildRoomRankMessage(msg, boolean)` 位置参数写法），开关会**静默失效** ——
 * 用户关掉「贡献榜」后 XML 里照样出表，而上面所有纯函数用例仍然全绿。
 */
describe('client.on("roomRank") 的接线', () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("把 saveRoomRank 开关传给构造器", () => {
    expect(src).toContain("save: this.saveRoomRank !== false");
  });

  it("仍用服务端时间戳兜底（默认 true）", () => {
    expect(src).toContain("useServerTimestamp: this.useServerTimestamp ?? true");
  });
});
