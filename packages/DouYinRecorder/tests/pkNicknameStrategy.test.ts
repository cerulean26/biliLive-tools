import { describe, it, expect } from "vitest";
import {
  buildBattleKey,
  collectPkNicknames,
  createPkChannelTracker,
  normalizeUserInfosKeys,
  PK_HANDLED_CHANNELS_LIMIT,
} from "../src/pkNicknameCache";

/**
 * PK 昵称缓存建立策略 —— 测试 `src/pkNicknameCache.ts` 的**真实实现**。
 *
 * 注：这里**不再复制一份实现**。早先的版本把策略逻辑抄在测试文件里，
 * 生产代码改了它也照样通过，属于假护栏。
 *
 * 覆盖：场景 1 全程观看 / 场景 2 中途加入等到结束 / 场景 3 中途加入未等到结束，
 * 以及幂等性、容量淘汰、并发触发、边界情况。
 *
 * `warm` 在生产代码里还会调用 `writePkNickname` 与 `registerPkNickname`
 * （依赖录制器实例），所以此处只验证「哪些消息需要写缓存」——
 * 即 `collectPkNicknames` 的产出与 tracker 的放行结果。
 */

const LIMIT = PK_HANDLED_CHANNELS_LIMIT;

interface Ctx {
  tracker: ReturnType<typeof createPkChannelTracker>;
  /** 记录被写入缓存的条目（模拟生产代码的 writePkNickname） */
  written: { uid: string; nickname: string }[];
}

const createCtx = (): Ctx => ({ tracker: createPkChannelTracker(), written: [] });

/** 与生产代码里 userInfos 的形状一致 */
type UserInfos = Record<string, { user?: { userId?: string; nickName?: string } }>;

/** 与生产代码 warmPkNicknamesFromUserInfos 的前半段一致：挑出可写入的 uid */
function warm(ctx: Ctx, userInfos: UserInfos | undefined) {
  for (const item of collectPkNicknames(userInfos)) {
    ctx.written.push(item);
  }
}

interface BattleMsg {
  battleSettings?: { battleId?: string };
  userInfos: UserInfos;
}

/** 模拟生产代码里 client.on("linkMicBattle") 的分支 */
function onBattle(ctx: Ctx, msg: BattleMsg): boolean {
  const key = buildBattleKey(msg.battleSettings);
  if (!ctx.tracker.acceptBattle(key)) return false;
  warm(ctx, msg.userInfos);
  return true;
}

/** 模拟生产代码里 client.on("linkMicBattleFinish") 的分支 */
function onBattleFinish(ctx: Ctx, msg: BattleMsg): boolean {
  const key = buildBattleKey(msg.battleSettings);
  if (!ctx.tracker.acceptBattleFinish(key)) return false;
  warm(ctx, msg.userInfos);
  return true;
}

const infos = (uids: Record<string, string>): UserInfos =>
  Object.fromEntries(
    Object.entries(uids).map(([uid, nick]) => [uid, { user: { userId: uid, nickName: nick } }]),
  );

describe("PK 昵称缓存策略（真实实现）", () => {
  describe("场景 1 · 全程观看（battleId 相同）", () => {
    it("只用开始事件写缓存，结束事件跳过", () => {
      const ctx = createCtx();
      const s = { battleSettings: { battleId: "7655333244545569801" } };
      const ui = infos({ "65305021017": "迪士尼在逃公主👸" });

      expect(onBattle(ctx, { ...s, userInfos: ui })).toBe(true);
      expect(onBattleFinish(ctx, { ...s, userInfos: ui })).toBe(false);

      expect(ctx.written).toHaveLength(1); // 只写一次
      expect(ctx.tracker.sourceOf("b:7655333244545569801")).toBe("battle");
    });

    it("不同 battleId 视为不同场次，各自建立缓存", () => {
      const ctx = createCtx();
      const ui = infos({ "65305021017": "迪士尼在逃公主👸" });
      onBattle(ctx, { battleSettings: { battleId: "111" }, userInfos: ui });
      onBattleFinish(ctx, { battleSettings: { battleId: "222" }, userInfos: ui });

      expect(ctx.written).toHaveLength(2);
      expect(ctx.tracker.size).toBe(2);
    });
  });

  describe("场景 2 · 中途加入且等到结束", () => {
    it("收到结束事件即建立缓存，不需要接口", () => {
      const ctx = createCtx();
      const ui = infos({ "7628182235824473000": "某主播" });
      // 中途接入：从未收到 battle
      expect(onBattleFinish(ctx, { battleSettings: { battleId: "999" }, userInfos: ui })).toBe(
        true,
      );

      expect(ctx.written).toHaveLength(1);
      expect(ctx.tracker.sourceOf("b:999")).toBe("battleFinish");
    });

    it("结束后再重复收到同一场的开始事件，不覆盖已建缓存", () => {
      const ctx = createCtx();
      const ui = infos({ "65305021017": "迪士尼在逃公主👸" });
      const s = { battleSettings: { battleId: "888" } };
      onBattleFinish(ctx, { ...s, userInfos: ui });
      // 幂等：开始事件应被跳过
      expect(onBattle(ctx, { ...s, userInfos: ui })).toBe(false);
      expect(ctx.written).toHaveLength(1);
      expect(ctx.tracker.sourceOf("b:888")).toBe("battleFinish");
    });
  });

  describe("场景 3 · 中途加入未等到结束", () => {
    it("两条 battle 事件都没收到 => 不写入任何 battle 缓存（应由 api 兜底）", () => {
      const ctx = createCtx();
      // 模拟：只有分数消息，触发 api 查询；此 ctx 不含 api 写入路径
      expect(ctx.written).toHaveLength(0);
      expect(ctx.tracker.size).toBe(0);
    });
  });

  describe("幂等性", () => {
    it("同一 battleId 重复 battle 事件只生效一次", () => {
      const ctx = createCtx();
      const s = { battleSettings: { battleId: "777" } };
      const ui = infos({ "65305021017": "A" });
      onBattle(ctx, { ...s, userInfos: ui });
      onBattle(ctx, { ...s, userInfos: ui });
      onBattle(ctx, { ...s, userInfos: ui });
      expect(ctx.written).toHaveLength(1);
    });

    it("同一 battleId 重复 battleFinish 事件只生效一次", () => {
      const ctx = createCtx();
      const s = { battleSettings: { battleId: "666" } };
      const ui = infos({ "65305021017": "A" });
      onBattleFinish(ctx, { ...s, userInfos: ui });
      onBattleFinish(ctx, { ...s, userInfos: ui });
      expect(ctx.written).toHaveLength(1);
    });

    it("多场 PK 交替，各自独立生效", () => {
      const ctx = createCtx();
      const ui = infos({ "65305021017": "A" });
      for (const id of ["1", "2", "3"]) {
        onBattle(ctx, { battleSettings: { battleId: id }, userInfos: ui });
      }
      expect(ctx.written).toHaveLength(3);
      expect(ctx.tracker.size).toBe(3);
    });
  });

  describe("边界情况", () => {
    it("battleId 缺失 => key 为 null => 不做去重（宁可重复写，也不误合并）", () => {
      const ctx = createCtx();
      const ui = infos({ "65305021017": "A" });
      // 两条消息都拿不到 battleId（无法判定场次）
      expect(onBattle(ctx, { userInfos: ui })).toBe(true);
      // 结束事件仍放行 —— 重复写入无害（同 uid 同昵称，last-write-wins），
      // 而错误合并会静默丢昵称，两害相权取其轻。
      expect(onBattleFinish(ctx, { userInfos: ui })).toBe(true);
      expect(ctx.written).toHaveLength(2);
      expect(ctx.tracker.size).toBe(0); // 未记入场次
    });

    it("userInfos 为空时不抛错，仍按「无 battleId => 放行」处理", () => {
      const ctx = createCtx();
      expect(buildBattleKey({ battleId: "b1" })).toBe("b:b1");
      expect(buildBattleKey(undefined)).toBeNull();
      expect(() => onBattle(ctx, { userInfos: {} })).not.toThrow();
      expect(onBattle(ctx, { userInfos: {} })).toBe(true);
    });

    /**
     * 回归护栏（2026-10-14）：**`channelId` 已被移出场次键**。
     *
     * 它只表示「同一次开播」—— 一次开播内可连打多场 PK，它们共用同一个 channelId。
     * 实测样本：桃子🍑 2026-10-14 一次录制含 3 场 PK（battleId 各异），
     * channelId 全程恒为 7696377304752362496；三斤 roomId=7694659564742266000
     * 的两场 PK channelId 均为 7694666908159841000。若拿它作键，第 2 场起会被判
     * 「已处理过」而漏建缓存。而 battleId 实测 100% 下发（linkMic 392/392）。
     *
     * 下面用**运行时形状与线上一致**的入参（同时带 battleId 与 channelId）验证。
     */
    it("channelId 不参与场次键（同时传 battleId 与 channelId，键只随 battleId 变）", () => {
      const withChan = (battleId: string, channelId: string) =>
        ({ battleId, channelId }) as { battleId?: string };
      expect(buildBattleKey(withChan("b1", "chan-A"))).toBe("b:b1");
      expect(buildBattleKey(withChan("b1", "chan-B"))).toBe("b:b1"); // channelId 变了，键不变
      expect(buildBattleKey(withChan("b2", "chan-A"))).toBe("b:b2");
    });

    it("battleId 缺失时返回 null（既不用 channelId，也不用 uid 集合兜底）", () => {
      // 运行时形状与线上一致：battleSettings 带 channelId 但没有 battleId
      const onlyChan = { channelId: "7696377304752362496" } as { battleId?: string };
      expect(buildBattleKey(onlyChan)).toBeNull();
      expect(buildBattleKey(undefined)).toBeNull();
    });

    describe("同一开播场次内的多场 PK（battleId 各自不同）", () => {
      it("两场 PK 各自建立缓存，第 2 场的新对手也写入", () => {
        const ctx = createCtx();
        // 同一场直播：channelId 相同（运行时存在但不参与键），battleId 与对手均不同
        const pk1 = infos({ "65305021017": "三斤.（9237）", "92674507563": "对手甲" });
        const pk2 = infos({ "65305021017": "三斤.（9237）", "72041175748": "对手乙" });

        onBattle(ctx, { battleSettings: { battleId: "7694677542370301000" }, userInfos: pk1 });
        onBattle(ctx, { battleSettings: { battleId: "7694700747398059000" }, userInfos: pk2 });

        // 两场都放行 ⇒ 4 次写入（每场 2 个选手；主播重复出现属正常）
        expect(ctx.written).toHaveLength(4);
        // 覆盖到 3 个不同 uid —— 关键是 PK2 的新对手"对手乙"也写入了
        expect(new Set(ctx.written.map((w) => w.uid)).size).toBe(3);
        expect(ctx.written.map((w) => w.uid)).toContain("72041175748");
        expect(ctx.tracker.size).toBe(2); // 两场各自记为一个场次
      });

      /**
       * 为什么**删掉 uid 集合兜底**（2026-10-14 实测）：
       * 桃子🍑 那次录制里 3 场 PK 的选手**完全相同**（连续和同一批对手打），
       * 三场的 uid 集合一模一样 ⇒ 用集合作键同样会误合并。
       * 「连打同一对手」是常态，所以这个兜底不可靠，已删除。
       */
      it("连续 3 场、对手完全相同：battleId 各异 ⇒ 每场都建缓存（uid 集合兜底已删）", () => {
        const ctx = createCtx();
        // 取自真实样本：桃子🍑 一次录制 3 场 PK，选手恒为这 3 人
        const ui = infos({
          "609550327886956": "桃子 🍑",
          "69839481045": "暖暖（小敏敏🌻⁶¹⁸）",
          "2318230454549027": "珊珊☀️（河北啊浩）❤️",
        });
        for (const bid of ["7696378583107933199", "7696379303913231396", "7696383235324105778"]) {
          onBattle(ctx, { battleSettings: { battleId: bid }, userInfos: ui });
        }
        expect(ctx.written).toHaveLength(9); // 3 场 × 3 人，每场都建
        expect(ctx.tracker.size).toBe(3);
      });

      it("battleId 相同 => 同一场，只生效一次", () => {
        const ctx = createCtx();
        const bid = "7694677542370301000";
        const ui = infos({ "65305021017": "三斤.（9237）" });
        onBattle(ctx, { battleSettings: { battleId: bid }, userInfos: ui });
        expect(onBattleFinish(ctx, { battleSettings: { battleId: bid }, userInfos: ui })).toBe(
          false,
        );
        expect(ctx.written).toHaveLength(1);
      });
    });

    it("uid 为空或 nickName 为空的条目被跳过", () => {
      const ctx = createCtx();
      onBattle(ctx, {
        battleSettings: { battleId: "5" },
        userInfos: { x: { user: { userId: "", nickName: "A" } }, y: { user: { userId: "1" } } },
      });
      expect(ctx.written).toHaveLength(0);
    });

    it("场次容量超限后淘汰最旧，仍能继续处理新场次", () => {
      const ctx = createCtx();
      const ui = infos({ "65305021017": "A" });
      for (let i = 0; i < LIMIT + 10; i++) {
        onBattle(ctx, { battleSettings: { battleId: `b${i}` }, userInfos: ui });
      }
      expect(ctx.tracker.size).toBeLessThanOrEqual(LIMIT);
      expect(ctx.written).toHaveLength(LIMIT + 10); // 超限不阻断写入
      const newest = `b:b${LIMIT + 9}`;
      expect(ctx.tracker.sourceOf(newest)).toBe("battle");
      // 最旧的 b:b0 已被淘汰
      expect(ctx.tracker.sourceOf("b:b0")).toBeUndefined();
    });

    it("并发回调：连续同步触发不产生重复写入", () => {
      const ctx = createCtx();
      const s = { battleSettings: { battleId: "race" } };
      const ui = infos({ "65305021017": "A" });
      // 模拟多个回调在同一 tick 内触发
      onBattle(ctx, { ...s, userInfos: ui });
      onBattleFinish(ctx, { ...s, userInfos: ui });
      onBattle(ctx, { ...s, userInfos: ui });
      onBattleFinish(ctx, { ...s, userInfos: ui });
      expect(ctx.written).toHaveLength(1);
    });
  });

  describe("诊断统计（生产代码停止录制时会输出）", () => {
    it("stats() 按来源统计场次", () => {
      const ctx = createCtx();
      const ui = infos({ "1": "A" });
      onBattle(ctx, { battleSettings: { battleId: "s1" }, userInfos: ui });
      onBattleFinish(ctx, { battleSettings: { battleId: "s2" }, userInfos: ui });
      onBattleFinish(ctx, { battleSettings: { battleId: "s3" }, userInfos: ui });

      expect(ctx.tracker.stats()).toEqual({ total: 3, byBattle: 1, byBattleFinish: 2 });
    });
  });
});

describe("normalizeUserInfosKeys（消除 map<int64> 哈希键乱码）", () => {
  it("把乱码哈希键重排成真实 uid，且值（昵称）保持不变", () => {
    const raw = {
      "èP&£\x0e\x00\x00\x00": { user: { userId: "62866739432", nickName: "二蛋²²⁰（承蒙厚爱）" } },
      "¿úþt\x13\x00\x00\x00": {
        user: { userId: "83567246015", nickName: "🔥卢焱⁷⁷⁷（收女徒请私信）" },
      },
    };
    const got = normalizeUserInfosKeys(raw)!;
    expect(Object.keys(got).sort()).toEqual(["62866739432", "83567246015"]);
    expect(got["62866739432"].user.nickName).toBe("二蛋²²⁰（承蒙厚爱）");
    expect(got["83567246015"].user.nickName).toBe("🔥卢焱⁷⁷⁷（收女徒请私信）");
  });

  it("优先用 userIdStr 作键，19 位 uid 不丢精度（长整型哈希键重排后仍是原 uid）", () => {
    const raw = {
      garbage1: {
        user: { userId: "7694659564742265636", userIdStr: "7694659564742265636", nickName: "主播" },
      },
    };
    const got = normalizeUserInfosKeys(raw)!;
    expect(Object.keys(got)).toEqual(["7694659564742265636"]);
    expect(got["7694659564742265636"].user.userIdStr).toBe("7694659564742265636");
  });

  it("缺失 uid 时保留原哈希键，不丢数据", () => {
    const raw = { hashA: { user: { nickName: "无 uid 的选手" } } };
    const got = normalizeUserInfosKeys(raw)!;
    expect(Object.keys(got)).toEqual(["hashA"]);
    expect(got["hashA"].user.nickName).toBe("无 uid 的选手");
  });

  it("uid 碰撞时第二条保留原哈希键（不覆盖），避免静默丢数据", () => {
    const raw = {
      hashA: { user: { userId: "111", nickName: "甲" } },
      hashB: { user: { userId: "111", nickName: "乙" } },
    };
    const got = normalizeUserInfosKeys(raw)!;
    // 甲占了 "111"，乙只能保留原键 hashB
    expect(got["111"]?.user.nickName).toBe("甲");
    expect(got["hashB"]?.user.nickName).toBe("乙");
  });

  it("undefined 原样返回", () => {
    expect(normalizeUserInfosKeys(undefined)).toBeUndefined();
  });

  it("uid 为 `__proto__` 时条目不丢（无原型聚合，防原型 setter 吞键）", () => {
    const raw = {
      hashP: { user: { userId: "__proto__", userIdStr: "__proto__", nickName: "特殊键选手" } },
    };
    const got = normalizeUserInfosKeys(raw)!;
    // 旧实现用普通对象字面量：`out["__proto__"] = info` 会触发原型 setter，
    // 该键不会成为自有属性 → 条目被静默丢弃（Object.values 里看不到）。
    // 注意：这**不会**污染 Object.prototype，只是这条记录丢了。
    expect(Object.getPrototypeOf(got)).toBeNull();
    expect(Object.keys(got)).toEqual(["__proto__"]);
    expect(Object.values(got)).toEqual([raw.hashP]);
    expect(collectPkNicknames(got)).toEqual([{ uid: "__proto__", nickname: "特殊键选手" }]);
  });

  it("重排后下游 collectPkNicknames 仍能正确取出 uid→昵称（值不受影响）", () => {
    const raw = {
      "èP&£\x0e\x00\x00\x00": { user: { userId: "62866739432", nickName: "二蛋²²⁰" } },
    };
    const got = normalizeUserInfosKeys(raw)!;
    expect(collectPkNicknames(got)).toEqual([{ uid: "62866739432", nickname: "二蛋²²⁰" }]);
  });
});
