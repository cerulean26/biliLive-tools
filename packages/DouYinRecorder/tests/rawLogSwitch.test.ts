import fs from "node:fs";

import { describe, it, expect } from "vitest";

import {
  describeDisabledRawLogs,
  isRawLogEnabled,
  resolveRawLogSwitches,
  type RawLogKind,
} from "../src/index";

/**
 * 四路原始报文转储「开关读取」与「全关提示」的护栏 —— 测试 `src/index.ts` 的真实实现。
 *
 * 这两件事原先藏在 `createXxxRawLogger` 的默认参数与 `checkLiveStatusAndRecord` 内部，
 * 无法断言。抽成纯函数后：
 * - `isRawLogEnabled`：固定「哪个 kind 读哪个环境变量」以及「只有 `"1"` 算开启」
 * - `describeDisabledRawLogs`：固定「全关才提示 / 只开一路不提示」
 */

const ALL_KINDS: RawLogKind[] = ["pk", "room", "rank", "gift"];

/** 四路全关的基线，便于逐路翻转 */
function switches(overrides: Partial<Record<RawLogKind, boolean>> = {}) {
  return {
    pk: false,
    room: false,
    rank: false,
    gift: false,
    ...overrides,
  } as Record<RawLogKind, boolean>;
}

describe("isRawLogEnabled:: 开关与变量名的对应", () => {
  const expected: Record<RawLogKind, string> = {
    pk: "BILILIVE_TOOLS_PK_RAW_LOG",
    room: "BILILIVE_TOOLS_ROOM_RAW_LOG",
    rank: "BILILIVE_TOOLS_RANK_RAW_LOG",
    gift: "BILILIVE_TOOLS_GIFT_RAW_LOG",
  };

  for (const kind of ALL_KINDS) {
    it(`${kind} 只读 ${expected[kind]}`, () => {
      expect(isRawLogEnabled(kind, { [expected[kind]]: "1" })).toBe(true);
      // 变量名写错/串台时这里会红：只设别的路的变量不应把本路点亮
      const others = ALL_KINDS.filter((k) => k !== kind).map((k) => [expected[k], "1"]);
      expect(isRawLogEnabled(kind, Object.fromEntries(others))).toBe(false);
    });
  }
});

describe("isRawLogEnabled:: 取值口径", () => {
  it('只有严格等于 "1" 才算开启', () => {
    expect(isRawLogEnabled("pk", { BILILIVE_TOOLS_PK_RAW_LOG: "1" })).toBe(true);
  });

  it('"0" / 空串 / 其他真值文本 / 未设置 都算关闭', () => {
    for (const value of ["0", "", "true", "yes", " 1", "1 "]) {
      expect(isRawLogEnabled("pk", { BILILIVE_TOOLS_PK_RAW_LOG: value })).toBe(false);
    }
    expect(isRawLogEnabled("pk", {})).toBe(false);
  });
});

describe("describeDisabledRawLogs:: 提示时机", () => {
  it("四路全关时返回提示，且点名四个变量", () => {
    const hint = describeDisabledRawLogs(switches());

    expect(hint).not.toBeNull();
    expect(hint).toContain("[rawLog]");
    expect(hint).toContain("均未启用");
    // 名字由 RAW_LOG_ENV_KEYS 推导：新增/改名一路后这里会跟着变（期望值随之更新）
    expect(hint).toContain("BILILIVE_TOOLS_{PK,ROOM,RANK,GIFT}_RAW_LOG");
  });

  it("只要有一路开启就不提示（该路由写入器自己打「已启用」）", () => {
    for (const kind of ALL_KINDS) {
      expect(describeDisabledRawLogs(switches({ [kind]: true }))).toBeNull();
    }
    expect(
      describeDisabledRawLogs(switches({ pk: true, room: true, rank: true, gift: true })),
    ).toBeNull();
  });
});

describe("resolveRawLogSwitches:: 设置页开关与环境变量取或", () => {
  /** 显式传空 env，避免用例结果依赖跑测试时的真实环境变量 */
  const noEnv: NodeJS.ProcessEnv = {};

  it("设置页开启即可生效（GUI 启动拿不到 env 的主路径）", () => {
    const out = resolveRawLogSwitches({ pk: true }, noEnv);

    expect(out.pk).toBe(true);
    // 只开一路不应把其它路带开
    expect(out.room).toBe(false);
    expect(out.rank).toBe(false);
    expect(out.gift).toBe(false);
  });

  it("环境变量仍可强制开启（兼容命令行取证的既有用法）", () => {
    const out = resolveRawLogSwitches({}, { BILILIVE_TOOLS_GIFT_RAW_LOG: "1" });

    expect(out.gift).toBe(true);
    expect(out.pk).toBe(false);
  });

  it("两者都为开时结果仍为开（幂等，不因配置 false 关掉 env）", () => {
    const out = resolveRawLogSwitches({ rank: true }, { BILILIVE_TOOLS_RANK_RAW_LOG: "1" });

    expect(out.rank).toBe(true);
  });

  it("环境变量为 0/空时不会关掉设置页已开的开关（取或的语义）", () => {
    const out = resolveRawLogSwitches({ room: true }, { BILILIVE_TOOLS_ROOM_RAW_LOG: "0" });

    expect(out.room).toBe(true);
  });

  it("都不设置时四路全关（含老配置 undefined 的情况）", () => {
    expect(resolveRawLogSwitches({}, noEnv)).toEqual({
      pk: false,
      room: false,
      rank: false,
      gift: false,
    });
    expect(resolveRawLogSwitches({ pk: undefined, room: undefined }, noEnv)).toEqual({
      pk: false,
      room: false,
      rank: false,
      gift: false,
    });
  });
});

/**
 * 源码级护栏：纯函数测不到「调用点有没有用它们」。
 *
 * 曾经的盲区是：全关时日志里空白，无法区分「环境变量没传到进程」与「传到了但值为 0」。
 * 若 `describeDisabledRawLogs` 的返回值被算出来却忘了打印（或写入器退回各自读 env），
 * 这个盲区会静默复活，而上面所有用例仍然全绿。
 */
describe("checkLiveStatusAndRecord 的接线", () => {
  const src = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("全关提示确实被打印", () => {
    expect(src).toContain("if (disabledRawLogHint) console.log(disabledRawLogHint);");
  });

  it("四路写入器接收同一份开关值（不再各自读 env）", () => {
    expect(src).toContain("createPkRawLogger(rawLogSwitches.pk)");
    expect(src).toContain("createRoomRawLogger(rawLogSwitches.room)");
    expect(src).toContain("createRankRawLogger(rawLogSwitches.rank)");
    expect(src).toContain("createGiftRawLogger(rawLogSwitches.gift)");
  });

  it("开关值来自 resolveRawLogSwitches，且把四个配置项都传进去", () => {
    expect(src).toContain("resolveRawLogSwitches({");
    for (const field of ["rawLogPk", "rawLogRoom", "rawLogRank", "rawLogGift"]) {
      expect(src).toContain(`this.${field}`);
    }
  });
});
