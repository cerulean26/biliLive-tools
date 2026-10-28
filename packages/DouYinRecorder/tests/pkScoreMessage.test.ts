import { describe, it, expect } from "vitest";
import { buildPkScoreMessage } from "../src/index";

/**
 * `pk_score` 消息构造的健壮性护栏 —— 测试 `src/index.ts` 的真实实现。
 *
 * 根因（实测）：`msg.userScores` 在 proto 里是 `repeated UserScores`，
 * 抖音的 `WebcastLinkMicMethod` 同时承载**非 PK 的普通连麦**消息，
 * 这类消息不含 `user_scores`，protobufjs 的 `toObject` 会给出 `undefined`
 * （实测：空 repeated 字段不进结果对象）。
 *
 * 生产代码此前写成 `for (const s of msg.userScores)` 与
 * `msg.userScores.map(...)` —— 对 `undefined` 会抛
 * `TypeError: ... is not iterable`，异常被 `DouYinDanma.decode` 的
 * try/catch 吞掉，导致**整条 PK 消息被静默丢弃**。
 *
 * 因此这些用例锁死「缺失/空时安全降级为不产出消息」。
 */

const PK_TS = 1_700_000_000_000;

describe("buildPkScoreMessage:: userScores 缺失/空值的健壮性", () => {
  it("userScores 缺失（undefined）时不抛错，返回 null", () => {
    // 模拟普通连麦消息：protobufjs toObject 在无 user_scores 时给出 undefined
    const msg = { common: { createTime: "1700000000" } } as Parameters<
      typeof buildPkScoreMessage
    >[0];
    expect(() => buildPkScoreMessage(msg, true)).not.toThrow();
    expect(buildPkScoreMessage(msg, true)).toBeNull();
  });

  it("userScores 为空数组时返回 null", () => {
    const out = buildPkScoreMessage({ userScores: [], common: { createTime: "1700000000" } }, true);
    expect(out).toBeNull();
  });

  it("userScores 全为缺 userId 的脏项时返回 null（不产出 uid=undefined 的行）", () => {
    const out = buildPkScoreMessage(
      {
        userScores: [{ score: "10" }, { userId: "", score: "20" }] as Parameters<
          typeof buildPkScoreMessage
        >[0]["userScores"],
        common: { createTime: "1700000000" },
      },
      true,
    );
    expect(out).toBeNull();
  });
});

describe("buildPkScoreMessage:: 正常路径", () => {
  it("产出带排序的 pk_score（rank 升序）", () => {
    const out = buildPkScoreMessage(
      {
        userScores: [
          { userId: "B", score: "5", battleRank: "2" },
          { userId: "A", score: "10", battleRank: "1" },
        ],
        common: { createTime: "1700000000" },
      },
      true,
    );
    expect(out).not.toBeNull();
    expect(out!.type).toBe("pk_score");
    expect(out!.players.map((p) => p.uid)).toEqual(["A", "B"]);
    expect(out!.players[0]).toEqual({
      uid: "A",
      score: "10",
      rank: "1",
      teamScore: "",
      teamRank: "",
    });
  });

  it("缺失的 score/rank/team 字段归一为空串，不出现 undefined", () => {
    const out = buildPkScoreMessage(
      { userScores: [{ userId: "A" }], common: { createTime: "1700000000" } },
      true,
    );
    expect(out!.players[0]).toEqual({
      uid: "A",
      score: "0",
      rank: "",
      teamScore: "",
      teamRank: "",
    });
  });

  it("脏项（缺 userId）被过滤，其余选手正常产出", () => {
    const out = buildPkScoreMessage(
      {
        userScores: [
          { userId: "A", score: "1", battleRank: "1" },
          { score: "99" }, // 无 userId，应被过滤
        ] as Parameters<typeof buildPkScoreMessage>[0]["userScores"],
        common: { createTime: "1700000000" },
      },
      true,
    );
    expect(out!.players.map((p) => p.uid)).toEqual(["A"]);
  });

  it("useServerTimestamp=true 时用服务端时间（秒级自动转毫秒）", () => {
    const out = buildPkScoreMessage(
      { userScores: [{ userId: "A" }], common: { createTime: "1700000000" } },
      true,
    );
    expect(out!.timestamp).toBe(PK_TS);
  });

  it("useServerTimestamp=false 时用本地时钟", () => {
    const out = buildPkScoreMessage({ userScores: [{ userId: "A" }] }, false, 12345);
    expect(out!.timestamp).toBe(12345);
  });

  it("服务端时间已是毫秒级（>9999999999）时不再乘 1000", () => {
    const out = buildPkScoreMessage(
      { userScores: [{ userId: "A" }], common: { createTime: "1700000000000" } },
      true,
    );
    expect(out!.timestamp).toBe(1_700_000_000_000);
  });

  it("createTime 缺失时回落到 now（不是 0）", () => {
    const out = buildPkScoreMessage({ userScores: [{ userId: "A" }] }, true, 1_700_000_123_000);

    expect(out!.timestamp).toBe(1_700_000_123_000);
  });

  it('createTime 为字符串 "0" 时同样回落到 now', () => {
    const out = buildPkScoreMessage(
      { userScores: [{ userId: "A" }], common: { createTime: "0" } },
      true,
      1_700_000_124_000,
    );

    expect(out!.timestamp).toBe(1_700_000_124_000);
  });
});

/**
 * 场次标识 `battleId` —— 一场直播可打多场 PK，快照只凭时间戳无法归属。
 * 它取自 `LinkMicMethod.battle_id`（proto 字段 104，实测 84/84 下发）。
 */
describe("buildPkScoreMessage:: 场次标识 battleId", () => {
  const base = { common: { createTime: "1700000000" }, userScores: [{ userId: "A", score: "1" }] };

  it("带 battleId 时原样带出", () => {
    const out = buildPkScoreMessage({ ...base, battleId: "7694677542370301000" }, true);
    expect(out!.battleId).toBe("7694677542370301000");
  });

  it("缺 battleId 时该键不出现（不写 undefined）", () => {
    const out = buildPkScoreMessage(base, true);
    // 与 XML 里 team_* 的处理一致：缺省时省略，而不是写出 battleId=""
    expect("battleId" in (out as object)).toBe(false);
  });

  it("同一次开播内的两场 PK：battleId 不同 ⇒ 可据此区分", () => {
    const mk = (bid: string) => buildPkScoreMessage({ ...base, battleId: bid }, true);
    expect(mk("7694677542370301000")!.battleId).not.toBe(mk("7694700747398059000")!.battleId);
  });
});
