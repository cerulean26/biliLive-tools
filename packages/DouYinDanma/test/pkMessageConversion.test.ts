import { describe, it, expect } from "vitest";
import { douyin } from "../src/proto";
// 导入即执行 index.ts 顶层的 Long 注入（util.Long = Long; configure()）
import "../src/index";
import { gzipSync } from "node:zlib";
import DouYinDanmaClient from "../src/index";

/**
 * 回归护栏：PK 消息的 decode→toJSON 转换路径。
 *
 * == 背景（一次被推翻的注释）==
 * 这里原先写成 `LinkMicMethod.toObject(decode(...), { longs: String })`，
 * 并附注释称「必须用 toObject({longs:String})，否则 toJSON() 默认转 Number 会丢精度」。
 * 实测证伪了该注释：
 *   - protobufjs 的 `util.toJSONOptions` 默认就是 `{ longs: String, enums: String,
 *     bytes: String, json: true }`（dist/minimal/protobuf.js:2150），
 *     而 `Message.prototype.toJSON` 内部正是 `toObject(this, util.toJSONOptions)`；
 *   - 用真实 19 位值对照，`toJSON()` 与 `toObject({longs:String})` 输出**完全一致**。
 * 真正会出问题的路径是 `toObject()` **不传 options** —— 它会原样返回 Long 对象
 * `{low, high, unsigned}`，被 JSON.stringify 后 uid 不可用。
 *
 * == 本测试的作用 ==
 * 把上述事实钉住：① 两条路径输出一致（可安全统一为 toJSON）；
 * ② 不传 options 确实会退化成 Long 对象（防止有人误改）。
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
/** tag = (fieldNo << 3) | wireType */
function ld(field: number, wire: number): number[] {
  return varint(BigInt((field << 3) | wire));
}
function fVarint(field: number, n: bigint): number[] {
  return [...ld(field, 0), ...varint(n)];
}
function fLenDelim(field: number, body: number[]): number[] {
  return [...ld(field, 2), ...varint(BigInt(body.length)), ...body];
}

/** 真实值（与 Go 版同一直播间对照得到，19 位，超出 2^53） */
const REAL_ROOM = "7694659564742265636";
const REAL_CHAN = "7694666908159841321";

/**
 * 构造 LinkMicBattleFinish 字节：
 *   battle_settings = 2 (BattleSettings)，其中 channel_id = 6
 */
function buildFinish(): Uint8Array {
  const settings = [
    ...fVarint(2, 777888999n), // battle_id
    ...fVarint(6, BigInt(REAL_CHAN)), // channel_id（19 位）
  ];
  return Uint8Array.from([...fLenDelim(2, [...fLenDelim(2, settings)])]);
}

describe("PK 消息的 decode → toJSON 转换路径", () => {
  it("toJSON() 与 toObject({longs:String}) 输出完全一致", () => {
    const m = douyin.LinkMicBattleFinish.decode(buildFinish());
    const viaJson = JSON.stringify(m.toJSON());
    const viaObj = JSON.stringify(douyin.LinkMicBattleFinish.toObject(m, { longs: String }));

    expect(viaJson).toBe(viaObj);
    // 两条路径都必须保留 19 位精度
    expect(viaJson).toContain(REAL_CHAN);
  });

  it("toJSON() 对 19 位 uint64 精确（不转 Number）", () => {
    const m = douyin.LinkMicBattleFinish.decode(buildFinish());
    const json = m.toJSON() as {
      battleSettings?: { channelId?: unknown; battleId?: unknown };
    };
    expect(json.battleSettings?.channelId).toBe(REAL_CHAN);
    expect(typeof json.battleSettings?.channelId).toBe("string");
    expect(json.battleSettings?.battleId).toBe("777888999");
  });

  it("toObject() 不传 options 会返回 Long 对象（uid 不可用）", () => {
    const m = douyin.LinkMicBattleFinish.decode(buildFinish());
    const noOpts = douyin.LinkMicBattleFinish.toObject(m) as {
      battleSettings?: { channelId?: unknown };
    };
    // 这正是「不能用裸 toObject」的原因：序列化后是 {low,high,unsigned}
    expect(typeof noOpts.battleSettings?.channelId).toBe("object");
    expect(noOpts.battleSettings?.channelId).toMatchObject({ unsigned: true });
  });

  it("嵌套 Common 的 19 位 roomId 同样精确", () => {
    // LinkMicBattleFinish.common = 1，Common.roomId = 3
    const common = [
      ...fVarint(1, 0n), // method（占位）
      ...fVarint(3, BigInt(REAL_ROOM)), // roomId 19 位
    ];
    const bytes = Uint8Array.from([...fLenDelim(1, common)]);
    const m = douyin.LinkMicBattleFinish.decode(bytes);
    const json = m.toJSON() as { common?: { roomId?: unknown } };
    expect(json.common?.roomId).toBe(REAL_ROOM);
  });
});

/**
 * 链路级护栏：直接驱动 `DouYinDanmaClient.decode()` 的 `WebcastLinkMicBattleFinishMethod`
 * 分支 —— 即 index.ts 里真正调 `toJSON()` 的那一行。
 *
 * 为什么需要它：上面那些用例只测了 proto.js 的方法本身，
 * 「把 index.ts 的 toJSON 改成裸 toObject」这种变异**不会**让它们变红（护栏有缺口）。
 * 这里构造完整 wire 链路 PushFrame → Response → Message → if-else 分支，
 * 断言 emit 出来的消息里 19 位 ID 是字符串，从而把 index.ts 的那行代码纳入覆盖。
 */
describe("index.ts 的 PK 分支（链路级）", () => {
  /** 构造一条 LinkMicBattleFinish 的 payload：battle_settings.channel_id = 19 位 */
  function finishPayload(): number[] {
    const settings = [...fVarint(2, 777888999n), ...fVarint(6, BigInt(REAL_CHAN))];
    return [...fLenDelim(2, [...fLenDelim(2, settings)])];
  }

  /** 包成 Message{ method, payload } */
  function wrapMessage(method: string, payload: number[]): number[] {
    return [
      ...(() => {
        const s = [...Buffer.from(method, "utf8")];
        return [...ld(1, 2), ...varint(BigInt(s.length)), ...s];
      })(),
      ...fLenDelim(2, payload),
    ];
  }

  /** Response.messagesList = 1（repeated Message） */
  function wrapResponse(msg: number[]): number[] {
    return [...fLenDelim(1, msg)];
  }

  /**
   * PushFrame.payload = 8。注意：decode() 会对 payload **无条件 gzip 解压**
   * （index.ts：`if (wssPackage.payload instanceof Buffer) decompressGzip(...)`），
   * 所以这里必须真的压缩，否则报 "incorrect header check"。
   */
  function wrapPushFrame(payload: number[]): Uint8Array {
    return Uint8Array.from([...fLenDelim(8, [...gzipSync(Buffer.from(payload))])]);
  }

  it("decode() 走 WebcastLinkMicBattleFinishMethod 分支，19 位 ID 为字符串", async () => {
    const client = new DouYinDanmaClient("123", { autoStart: false });
    const received: unknown[] = [];
    client.on("linkMicBattleFinish", (m) => received.push(m));

    const wire = wrapPushFrame(
      wrapResponse(wrapMessage("WebcastLinkMicBattleFinishMethod", finishPayload())),
    );

    await client.decode(Buffer.from(wire));

    expect(received).toHaveLength(1);
    const msg = received[0] as {
      battleSettings?: { channelId?: unknown; battleId?: unknown };
    };
    expect(msg.battleSettings?.channelId).toBe(REAL_CHAN);
    expect(typeof msg.battleSettings?.channelId).toBe("string");
    expect(msg.battleSettings?.battleId).toBe("777888999");
  });
});
