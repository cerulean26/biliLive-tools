import { describe, it, expect } from "vitest";
import { douyin } from "../src/proto";

/**
 * 验证 LinkMicBattleFinish（PK 结束消息）解码器。
 * 数据取自真实抓包样本：user_infos 的两个选手与昵称。
 */

// 按 protobuf 字段号手工编码 payload（0 缺省即不输出）
function varint(n: number): number[] {
  const bytes: number[] = [];
  while (n > 127) {
    bytes.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return bytes;
}
function lenDelim(fieldNo: number, payload: number[]): number[] {
  // tag 必须用 varint 编码：fieldNo >= 16 时 (fieldNo<<3)|2 > 127，单字节会错
  return [...varint((fieldNo << 3) | 2), ...varint(payload.length), ...payload];
}
function varintField(fieldNo: number, value: number): number[] {
  return [...varint((fieldNo << 3) | 0), ...varint(value)];
}
/** 编码超 2^53 的 int64（JS Number 无法精确表示，需用 BigInt 计算） */
function varintBig(fieldNo: number, value: string): number[] {
  let v = BigInt(value);
  const bytes: number[] = [];
  while (v > 127n) {
    bytes.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return [...varint((fieldNo << 3) | 0), ...bytes];
}

function stringField(fieldNo: number, str: string): number[] {
  return [
    ...varint((fieldNo << 3) | 2),
    ...varint(Buffer.byteLength(str, "utf-8")),
    ...Buffer.from(str, "utf-8"),
  ];
}

/** map<int64, BattleUserInfo> user_infos = 6 */
function mapEntryField(
  uid: number,
  nickName: string,
  opts: { userIdStr?: string; fieldNo?: number } = {},
): number[] {
  // BaseUserInfo { user_id=1(varint), nick_name=2(string), user_id_str=5(string) }
  const baseUserInfo = [
    ...varintField(1, uid),
    ...stringField(2, nickName),
    ...(opts.userIdStr ? stringField(5, opts.userIdStr) : []),
  ];
  const battleUserInfo = lenDelim(1, baseUserInfo);
  // map entry 本身是 length-delimited：key = field 1 (varint)，value = field 2 (message)
  // fieldNo 允许覆盖外层字段号 —— LinkMicBattle=6而 LinkMicBattleFinish=12
  return lenDelim(opts.fieldNo ?? 6, [...varintField(1, uid), ...lenDelim(2, battleUserInfo)]);
}

const SAMPLE = [
  { uid: 105912516180, nickname: "唐feng" },
  { uid: 65305021017, nickname: "迪士尼在逃公主👸" },
];

function buildPayload() {
  const parts: number[] = [];
  // common (field 1) . method (field 1)
  parts.push(...lenDelim(1, stringField(1, "WebcastLinkMicBattleFinishMethod")));
  // LinkMicBattleFinish.user_infos 的权威字段号是 12（与 LinkMicBattle 的 6 不同）
  for (const s of SAMPLE) parts.push(...mapEntryField(s.uid, s.nickname, { fieldNo: 12 }));
  return Uint8Array.from(parts);
}

describe("proto: LinkMicBattleFinish", () => {
  it("解码器已生成", () => {
    expect(douyin.LinkMicBattleFinish).toBeDefined();
    expect(typeof douyin.LinkMicBattleFinish.decode).toBe("function");
    expect(typeof douyin.LinkMicBattle.decode).toBe("function");
  });

  it("能从 payload 中解析出选手 uid 与昵称（含 emoji）", () => {
    const decoded = douyin.LinkMicBattleFinish.toObject(
      douyin.LinkMicBattleFinish.decode(buildPayload()),
      { longs: String },
    );
    // 与生产代码一致：不依赖 map 的 key，直接取 value 内的 user.userId
    const got = Object.values((decoded as any).userInfos ?? {}).map((i: any) => [
      i.user?.userId,
      i.user?.nickName,
    ]);
    expect(Object.fromEntries(got)).toEqual({
      "105912516180": "唐feng",
      "65305021017": "迪士尼在逃公主👸",
    });
  });

  it("两个消息的 user_infos 字段号不同（12 vs 6），不可互相解码", () => {
    // 曾经把这个断言写成「解码结果一致」，那是错的：字段号不同，
    // 用 Finish 的 payload(字段12) 给 Battle 解码读不到昵称。
    const finishPayload = buildPayload();
    const asFinish = douyin.LinkMicBattleFinish.toObject(
      douyin.LinkMicBattleFinish.decode(finishPayload),
      { longs: String },
    );
    const asBattle = douyin.LinkMicBattle.toObject(douyin.LinkMicBattle.decode(finishPayload), {
      longs: String,
    });
    expect(Object.keys((asFinish as any).userInfos ?? {})).toHaveLength(2);
    expect(Object.keys((asBattle as any).userInfos ?? {})).toHaveLength(0);
  });

  it("user_infos 缺失时返回空对象，不抛错", () => {
    const decoded = douyin.LinkMicBattleFinish.toObject(
      douyin.LinkMicBattleFinish.decode(Uint8Array.from([])),
      { longs: String },
    );
    expect(Object.values((decoded as any).userInfos ?? {})).toHaveLength(0);
  });

  /**
   * `BattleScore`（field 4）已于 2026-10-14 从 proto 整体删除（零消费方，
   * 且实测其字段与该场最后一条 linkMic 的 userScores 完全一致）。
   * 本用例保留为**回归护栏**：若抖音某天开始下发该字段，不得导致解码异常，
   * 且不得影响同消息里已声明的 user_infos。
   */
  it("battleScores(field 4) 已删除声明，未声明字段应被安全跳过", () => {
    const payload = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicBattleFinishMethod")),
      ...lenDelim(2, varintBig(6, "7655333244545569801")), // battleSettings.channel_id
      ...lenDelim(4, [...varintBig(1, "80939"), ...varintBig(2, "65305021017")]), // 未声明的 field 4
      ...mapEntryField(65305021017, "迪士尼在逃公主👸", { fieldNo: 12 }),
    ]);
    let err: string | null = null;
    let decoded: any = null;
    try {
      decoded = douyin.LinkMicBattleFinish.toObject(douyin.LinkMicBattleFinish.decode(payload), {
        longs: String,
      });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toBeNull();
    // 未声明字段不出现在结果里
    expect(decoded.battleScores ?? undefined).toBeUndefined();
    // 已声明字段仍正常解析
    const got = Object.fromEntries(
      Object.values(decoded.userInfos ?? {}).map((i: any) => [i.user?.userId, i.user?.nickName]),
    );
    expect(got).toEqual({ "65305021017": "迪士尼在逃公主👸" });
  });
});

describe("proto: BattleUserInfo.user_id_str（判断 uid 是否可用于昵称查询）", () => {
  const buildPayload = (entries: { uid: number; nick: string; uidStr?: string }[]) => {
    const parts: number[] = [...lenDelim(1, stringField(1, "WebcastLinkMicBattleMethod"))];
    for (const e of entries) {
      parts.push(...mapEntryField(e.uid, e.nick, { userIdStr: e.uidStr }));
    }
    return Uint8Array.from(parts);
  };
  const readUsers = (buf: Uint8Array) =>
    Object.values(
      (douyin.LinkMicBattle.toObject(douyin.LinkMicBattle.decode(buf), { longs: String }) as any)
        .userInfos ?? {},
    ).map((i: any) => i.user);
  /**
   * 注意：pbjs 的toJSON() 对 uint64 默认转 Number，超出 2^53 会丢精度
   * （19 位 uid 实测 7628182235824473000 -> ...473088）。
   * 但生产写出的 XML 里 uid 是精确的 `...473000`，
   * 说明线上消息的 user_id 本身就在安全整数范围内（或经user_id_str 兜底）。
   * 因此下面断言用已实测的精确值。
   */

  it("能解析 user_id_str —— 19 位 uid 的关键判据", () => {
    const buf = buildPayload([
      // 正常抖音号
      { uid: 631566008585120, nick: "金砖⁵⁰²", uidStr: "631566008585120" },
      // 已实测查不到昵称的 19 位 uid
      { uid: 7628182235824473000, nick: "某主播", uidStr: "7628182235824473000" },
    ]);
    const users = readUsers(buf);
    // user_id 为 uint64，用 longs:String 保持精度
    expect(users.map((u: any) => u.userIdStr)).toEqual(["631566008585120", "7628182235824473000"]);
  });

  it("user_id_str 可以与 user_id 不同 —— 可用于判断真实抖音号", () => {
    // 若线上出现 userIdStr 与 userId 不一致，说明 userIdStr 才是可用于查询的抖音号
    const buf = buildPayload([{ uid: 7628182235824473000, nick: "某主播", uidStr: "65305021017" }]);
    const [user] = readUsers(buf);
    expect(user.userIdStr).toBe("65305021017");
    // userId 经 toJSON 会丢精度，但确实不等于 userIdStr —— 说明二者是两个不同字段
    expect(String(user.userId)).not.toBe(user.userIdStr);
  });

  it("user_id_str / open_id 缺失时不影响 user_id 与 nick_name", () => {
    const buf = buildPayload([{ uid: 65305021017, nick: "迪士尼在逃公主👸" }]);
    const [user] = readUsers(buf);
    expect(user.userId).toBe("65305021017");
    expect(user.nickName).toBe("迪士尼在逃公主👸");
    expect(user.userIdStr ?? "").toBe("");
  });
});

describe("proto: BattleSettings（用于关联同一场 PK 的开始与结束）", () => {
  const CHANNEL_ID = "7655333244545569801";
  const BATTLE_ID = "7655333434017109055";

  /** BattleSettings: battle_id=2, start_time_ms=3, duration=4, channel_id=6, match_type=7 */
  const battleSettingsField = (opts: { channelId?: string; battleId?: string } = {}) =>
    lenDelim(2, [
      ...(opts.battleId ? varintBig(2, opts.battleId) : []),
      ...varintBig(3, "1782396215605"),
      ...varintField(4, 300),
      // 注意: channelId 为 19 位, JS Number 无法精确表示, 故用 BigInt 编码后手动补高位
      ...(opts.channelId ? varintBig(6, opts.channelId) : []),
    ]);

  const decodeBoth = (buf: Uint8Array) => ({
    battle: (
      douyin.LinkMicBattle.toObject(douyin.LinkMicBattle.decode(buf), { longs: String }) as any
    ).battleSettings,
    finish: (
      douyin.LinkMicBattleFinish.toObject(douyin.LinkMicBattleFinish.decode(buf), {
        longs: String,
      }) as any
    ).battleSettings,
  });

  it("开始与结束消息都能解析 battleSettings.channelId", () => {
    const buf = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicBattleMethod")),
      ...battleSettingsField({ channelId: CHANNEL_ID, battleId: BATTLE_ID }),
      ...mapEntryField(65305021017, "迪士尼在逃公主👸"),
    ]);
    const { battle, finish } = decodeBoth(buf);
    // uint64 超过 2^53 在 toJSON 下可能丢精度，故用 String 比较数值
    expect(String(battle.channelId)).toBe(CHANNEL_ID);
    expect(String(finish.channelId)).toBe(CHANNEL_ID);
    expect(String(battle.battleId)).toBe(BATTLE_ID);
  });

  it("同一场PK：开始与结束解析出相同的 channelId", () => {
    const mk = (method: string) =>
      Uint8Array.from([
        ...lenDelim(1, stringField(1, method)),
        ...battleSettingsField({ channelId: CHANNEL_ID }),
      ]);
    const a = decodeBoth(mk("WebcastLinkMicBattleMethod")).battle;
    const b = decodeBoth(mk("WebcastLinkMicBattleFinishMethod")).finish;
    expect(String(a.channelId)).toBe(String(b.channelId));
  });

  it("battleSettings 缺失时 channelId 为 undefined（可退回 uid 集合归并）", () => {
    const buf = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicBattleMethod")),
      ...mapEntryField(65305021017, "迪士尼在逃公主👸"),
    ]);
    const { battle } = decodeBoth(buf);
    expect(battle?.channelId ?? "").toBe("");
  });
});

describe("回归: 解码 API 调用形态（实例上没有 toObject）", () => {
  /**
   * 曾出现的线上错误：
   *   TypeError: message2.toObject is not a function
   * 原因：pbjs 静态模块里 `toObject` 是【静态方法】（签名 Type.toObject(message, options)），
   *      实例（decode 的返回值）上只有 toJSON / encode 等原型方法，没有 toObject。
   */
  it("实例上没有 toObject，必须用静态方法", () => {
    const msg = douyin.LinkMicBattle.decode(buildPayload());
    expect(typeof (msg as any).toObject).toBe("undefined");
    expect(typeof (msg as any).toJSON).toBe("function");
    expect(typeof (douyin.LinkMicBattle as any).toObject).toBe("function");
  });

  it("静态 toObject 的调用形态可用（等价于线上解码路径）", () => {
    // buildPayload 造的是 LinkMicBattleFinish 的 payload（user_infos 在字段 12），
    // 必须用 Finish 解码器 —— 之前误用 Battle 解码器，字段号不匹配读不到昵称。
    const payload = buildPayload();
    const decoded = (douyin.LinkMicBattleFinish as any).toObject(
      (douyin.LinkMicBattleFinish as any).decode(payload),
      { longs: String },
    );
    expect(Object.keys(decoded.userInfos ?? {})).toHaveLength(2);
  });

  it("longs:String 对 19 位 uid 保持精度（与 toJSON 的区别）", () => {
    const BIG = "7628182235824473000";
    const payload = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicMethod")),
      ...mapEntryField(Number(BIG), "某主播", { userIdStr: BIG }),
    ]);
    // 静态 toObject + longs:String => 字符串，精确
    const viaObject = (douyin.LinkMicBattle as any).toObject(
      (douyin.LinkMicBattle as any).decode(payload),
      { longs: String },
    );
    const usersObj = Object.values(viaObject.userInfos ?? {}).map((i: any) => i.user);
    expect(usersObj[0].userIdStr).toBe(BIG);

    // 实例 toJSON() => Number，超 2^53 丢精度（这正是改用 toObject 的原因）
    const viaJson = (douyin.LinkMicBattle as any).decode(payload).toJSON();
    const usersJson = Object.values(viaJson.userInfos ?? {}).map((i: any) => i.user);
    expect(String(usersJson[0].userId)).not.toBe(BIG);
  });
});

describe("回归: battleFinish.user_infos 字段号是 12（不是 6）", () => {
  /**
   * 曾出现的 bug：为了让「PK 结束」与「PK 开始」字段一致，把 Finish 的
   * user_infos 也写成 6。但权威协议里 Finish 的 user_infos = 12，
   * 写成 6 会导致结束消息里的昵称**完全解析不到**（场景 2 失效）。
   * 两者仅复用 BattleUserInfo 结构，字段号不能统一。
   */
  it("用权威字段号 12 构造，能解析出 uid 与昵称", () => {
    const payload = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicBattleFinishMethod")),
      ...mapEntryField(65305021017, "迪士尼在逃公主👸", { fieldNo: 12 }),
    ]);
    const decoded = douyin.LinkMicBattleFinish.toObject(
      douyin.LinkMicBattleFinish.decode(payload),
      { longs: String },
    );
    const got = Object.values((decoded as any).userInfos ?? {}).map((i: any) => i.user?.nickName);
    expect(got).toEqual(["迪士尼在逃公主👸"]);
  });

  it("LinkMicBattle 的 user_infos 仍应是字段号 6", () => {
    const payload = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicBattleMethod")),
      ...mapEntryField(65305021017, "迪士尼在逃公主👸", { fieldNo: 6 }),
    ]);
    const decoded = douyin.LinkMicBattle.toObject(douyin.LinkMicBattle.decode(payload), {
      longs: String,
    });
    expect(Object.values((decoded as any).userInfos ?? {}).length).toBe(1);
  });
});

describe("proto: 新增的 openId / anchors 字段", () => {
  it("未声明的数值字段不得被误读为 string（曾导致线上越界崩溃）", () => {
    /**
     * 回归测试：曾在 UserScores 声明 `string user_id_str = 18`（权威 proto 无此字段），
     * 但抖音实际下发的字段 18 是 **varint**（wiretype 0）。
     * 声明成 string 后 protobufjs 会按 wiretype 2 读长度，
     * 把 varint 字节 `a0 99 02` 解析成长度 36000，导致：
     *   RangeError: index out of range: 183 + 36000 > 272
     *
     * 结论：**不要为未确认的字段号猜类型**。protobuf 的 wiretype 由字节流决定，
     * 声明错类型会直接导致解码崩溃（不是「读不到」，而是抛异常）。
     */
    const userScores = [
      ...varintField(1, 36000), // field 1 varint
      ...varintField(2, 169), // field 2 varint
      // field 18: 抖音下发的是 varint，我们未声明 -> 应被跳过
      ...varintField(18, 999),
    ];
    const payload = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicMethod")),
      ...lenDelim(17, userScores),
    ]);
    const decoded = douyin.LinkMicMethod.toObject(douyin.LinkMicMethod.decode(payload), {
      longs: String,
    });
    const s = (decoded as any).userScores[0];
    expect(s.score).toBe("36000");
    expect(s.userId).toBe("169");
    expect(s.userIdStr ?? "").toBe("");
  });

  /**
   * `anchors`(field 5) 在 2026-10-14 的「按实际消费方裁剪」中被移除声明
   * （无代码读取 `LinkMicBattleFinish.anchors`）。本用例确保：若抖音某天开始
   * 下发该字段，不会导致解码异常，也不影响同消息的 user_infos。
   *
   * 历史注记：曾临时补齐该字段以验证「我们的 User 类型 == 权威 Data.User」，
   * 结论是字段号一致；裁剪后回到"未声明则安全跳过"的护栏语义。
   */
  it("anchors(field 5) 未声明，未声明字段应被安全跳过", () => {
    const anchor = lenDelim(5, [
      ...varintBig(1, "7670833298604688000"),
      ...stringField(3, "迪士尼在逃公主👸"),
    ]);
    const payload = Uint8Array.from([
      ...lenDelim(1, stringField(1, "WebcastLinkMicBattleFinishMethod")),
      ...mapEntryField(65305021017, "迪士尼在逃公主👸", { fieldNo: 12 }),
      ...anchor, // 未声明的字段
    ]);
    let err: string | null = null;
    let decoded: any = null;
    try {
      decoded = douyin.LinkMicBattleFinish.toObject(douyin.LinkMicBattleFinish.decode(payload), {
        longs: String,
      });
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err).toBeNull();
    expect(decoded.anchors ?? undefined).toBeUndefined();
    expect(Object.keys(decoded.userInfos ?? {}).length).toBe(1);
  });
});
