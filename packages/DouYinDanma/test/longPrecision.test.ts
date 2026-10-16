import { describe, it, expect } from "vitest";
import * as pb from "protobufjs/minimal.js";
import { douyin } from "../src/proto";
// 导入即执行 index.ts 顶层的 Long 注入（util.Long = Long; configure()）
import "../src/index";

/**
 * 回归测试：19 位 uint64 ID 精度丢失（线上真实事故）
 *
 * == 现象 ==
 * 同一场 PK，Go 版（D:\code\douyinLive）抓到 roomId = 7694659564742265636（真实值），
 * 本项目日志里是 7694659564742266000（= Number(真实值).toString()）。
 *
 * == 根因 ==
 * protobufjs 用 `util.inquire("long")` 加载 long 库，@protobufjs/inquire 的实现是
 * `eval("require")("long")`（源码注释："hides the call from bundlers"），
 * 打包器看不到这条依赖 → 产物缺 long → 运行时 util.Long === null。
 * 而 Reader._configure 里 `var fn = util.Long ? "toLong" : "toNumber"` 只求值一次，
 * 于是所有 uint64 在 decode 阶段就被读成 JS 浮点数，超过 2^53 的 19 位 ID 低位抹零。
 *
 * == 修复 ==
 * 静态 import long（打包器可见）+ 显式 `util.Long = Long` + `configure()` 重绑 fn。
 *
 * 详见 src/index.ts 顶部注释。
 */

/** protobuf varint 编码 */
function varint(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

/** 构造只含单个 varint 字段的 message 字节 */
function uint64Field(fieldNo: number, value: bigint): Uint8Array {
  return Uint8Array.from([...varint(BigInt((fieldNo << 3) | 0)), ...varint(value)]);
}

const util = pb.util as unknown as { Long: unknown };

describe("19 位 uint64 精度（线上事故回归）", () => {
  // 真实值取自 Go 版对同一直播间的抓取
  const REAL_ROOM = "7694659564742265636";
  const REAL_CHAN = "7694666908159841321";
  // 线上曾产出的错误值，恰好等于 Number(真实值).toString()
  const ROUNDED_ROOM = "7694659564742266000";

  // Common.room_id = 3 / Common.channel_id = 21（均为 uint64）
  const roomIdBytes = uint64Field(3, BigInt(REAL_ROOM));
  const chanIdBytes = uint64Field(21, BigInt(REAL_CHAN));

  const decodeRoomId = (): string =>
    (douyin.Common.toObject(douyin.Common.decode(roomIdBytes), { longs: String }) as any)
      .roomId as string;

  it("index.ts 顶层已完成 Long 注入", () => {
    expect(util.Long).toBeTruthy();
  });

  it("roomId 解码结果与 Go 版真实值一致", () => {
    expect(decodeRoomId()).toBe(REAL_ROOM);
  });

  it("channelId 解码精确", () => {
    const obj: any = douyin.Common.toObject(douyin.Common.decode(chanIdBytes), {
      longs: String,
    });
    expect(obj.channelId).toBe(REAL_CHAN);
  });

  it("反向验证：置空 util.Long 后必须复现线上错误值", () => {
    const saved = util.Long;
    try {
      util.Long = null;
      pb.configure(); // 重新绑定 Reader 的 fn = "toNumber"
      const got = decodeRoomId();
      expect(got).toBe(ROUNDED_ROOM);
      expect(got).not.toBe(REAL_ROOM);
    } finally {
      util.Long = saved;
      pb.configure();
    }
    // 恢复后必须回到精确
    expect(decodeRoomId()).toBe(REAL_ROOM);
  });

  it.each([
    ["2^53-1（float64 精确上限）", 9007199254740991n],
    ["2^53", 9007199254740992n],
    ["2^53+1", 9007199254740993n],
    ["2^62", 4611686018427387904n],
    ["2^63", 9223372036854775808n],
    ["2^64-1（uint64 上限）", 18446744073709551615n],
  ])("边界 %s 精确", (_name, v) => {
    const obj: any = douyin.Common.toObject(douyin.Common.decode(uint64Field(3, v)), {
      longs: String,
    });
    expect(obj.roomId).toBe(v.toString());
  });

  it("int64 负数（Message.msgId）保留符号", () => {
    const NEG = -1234567890123456789n;
    const twos = BigInt.asUintN(64, NEG);
    const obj: any = douyin.Message.toObject(douyin.Message.decode(uint64Field(3, twos)), {
      longs: String,
    });
    expect(obj.msgId).toBe(NEG.toString());
  });

  it("long 包满足 protobufjs 的运行时期待", () => {
    const L = util.Long as any;
    expect(typeof L.isLong).toBe("function");
    const v = L.fromValue(REAL_ROOM);
    expect(L.isLong(v)).toBe(true);
    expect(v.toString()).toBe(REAL_ROOM);
    // fromObject 会「构造后赋值 unsigned」，所以它必须是可写字段
    v.unsigned = true;
    expect(v.unsigned).toBe(true);
  });
});

/**
 * 方案 A（import "protobufjs/minimal.js" 而非裸子路径 + ambient 声明）的护栏：
 * 若 `/minimal.js` 与 `proto.js` 内部的 `$protobuf` **不是同一模块实例**，
 * 则 index.ts 里 `util.Long = Long` 会注入到另一份 util，19 位精度修复静默失效。
 * 这个用例通过「解码一个 19 位值」间接证明注入作用在了 proto.js 的实例上。
 */
it("minimal.js 与 proto.js 是同一模块实例（Long 注入生效的充要条件）", () => {
  const REAL = "7694659564742265636";
  // LinkMicBattleFinish.battle_settings = 2，BattleSettings.channel_id = 6
  function varintOf(n: bigint): number[] {
    const out: number[] = [];
    let v = n;
    while (v > 127n) {
      out.push(Number(v & 127n) | 128);
      v >>= 7n;
    }
    out.push(Number(v));
    return out;
  }
  const settings = varintOf(6n).length
    ? [...varintOf((6n << 3n) | 0n), ...varintOf(BigInt(REAL))]
    : [];
  const inner = [...varintOf((2n << 3n) | 2n), ...varintOf(BigInt(settings.length)), ...settings];
  const bytes = Uint8Array.from([
    ...varintOf((2n << 3n) | 2n),
    ...varintOf(BigInt(inner.length)),
    ...inner,
  ]);

  const decoded = douyin.LinkMicBattleFinish.decode(bytes);
  const channelId = (decoded.toJSON() as { battleSettings?: { channelId?: unknown } })
    .battleSettings?.channelId;
  expect(channelId).toBe(REAL);
});
