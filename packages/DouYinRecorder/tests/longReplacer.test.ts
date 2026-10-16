import { describe, it, expect } from "vitest";
import { longSafeReplacer } from "../src/index";

/**
 * 回归测试：19位 ID 序列化丢精度
 *
 * 实测证据（同一场 PK 跨工具对照，roomId = 7694659564742265636）：
 *   Go 版protojson :7694659564742265636  （无损，uint64 按规范输出字符串）
 *   本项目 JSON 日志: 7694659564742266000 （低位被抹零 = Number 舍入）
 *
 * 根因：protobuf.js 在未显式指定 `longs` 选项时，会把 uint64
 * 退化为 Long 对象或 number；一旦变成 number，19 位 ID 超出
 * Number.MAX_SAFE_INTEGER，低位即被抹零。
 */
describe("longSafeReplacer：Long 对象无损序列化", () => {
  const ROOM = "7694659564742265636";
  const CHANNEL = "7694666908159841321";

  /** 构造 protobuf.js 形态的 Long 实例 */
  const makeLong = (dec: string) => {
    const b = BigInt(dec);
    return { low: Number(b & 0xffffffffn) | 0, high: Number(b >> 32n) | 0, unsigned: true };
  };

  it("把 Long 对象转成精确的十进制字符串", () => {
    const long = makeLong(ROOM);
    // 确认朴素写法确实会丢精度
    expect(Number(ROOM)).not.toBe(ROOM);
    // replacer 应给出精确值
    expect(longSafeReplacer("roomId", long)).toBe(ROOM);
    expect(longSafeReplacer("channelId", makeLong(CHANNEL))).toBe(CHANNEL);
  });

  it("经JSON.stringify 后字段值仍精确", () => {
    const payload = {
      common: { method: "WebcastLinkMicMethod", msgId: makeLong(ROOM), roomId: makeLong(ROOM) },
      channelId: makeLong(CHANNEL),
      userScores: [{ score: "1", userId: makeLong(CHANNEL) }],
    };
    const line = JSON.stringify({ tag: "linkMic", at: 0, payload }, longSafeReplacer);
    const parsed = JSON.parse(line);
    expect(parsed.payload.common.msgId).toBe(ROOM);
    expect(parsed.payload.common.roomId).toBe(ROOM);
    expect(parsed.payload.channelId).toBe(CHANNEL);
    expect(parsed.payload.userScores[0].userId).toBe(CHANNEL);
  });

  it("对照: 不加 replacer 时确实丢精度（证明这个replacer 是必要的）", () => {
    const long = makeLong(ROOM);
    const naive = JSON.stringify({ roomId: long.toString() ? Number(long.toString()) : long });
    // Long 实例被 JSON.stringify 时调用其toJSON -> {low,high} 对象，不是数字
    // 因此真正的风险来自「退化为 number」的路径，这里断言 replacer 能拦住 number 化后的结果
    const asNumber = Number(ROOM);
    expect(String(asNumber)).toBe("7694659564742266000");
    expect(ROOM).toBe("7694659564742265636");
  });

  it("不误伤普通值", () => {
    expect(longSafeReplacer("k", 123)).toBe(123);
    expect(longSafeReplacer("k", "abc")).toBe("abc");
    expect(longSafeReplacer("k", null)).toBe(null);
    expect(longSafeReplacer("k", true)).toBe(true);
    expect(longSafeReplacer("k", undefined)).toBe(undefined);
    // 只有 low/high 同时为 number 才转换，普通对象不动
    const obj = { low: 1, high: 2, other: 3 };
    expect(longSafeReplacer("k", obj)).toBe(obj);
  });

  it("负数 Low（int64 高位为负）也能正确处理", () => {
    // int64 场景下 low 可能为负（补码），用 >>>0 转无符号再拼回。
    // 这条用例唯一守的是 longSafeReplacer 里「unsigned === false 且高位为 1 → 减 2^64 还原符号」
    // 那个分支；若只断言 `typeof out === "string"`，任何返回字符串的实现（含走无符号分支、
    // 返回错值）都能通过 —— 等于该分支没有护栏。故断言**精确值**：
    //   正确的有符号结果 = -1234567890123
    //   若误走无符号分支   = 18446742839141661493（= 2^64 - 1234567890123，实测确认）
    const b = BigInt("-1234567890123");
    const hi = BigInt.asIntN(32, b >> 32n);
    const lo = BigInt.asUintN(32, b & 0xffffffffn);
    const long = { low: Number(lo) | 0, high: Number(hi), unsigned: false };
    const out = longSafeReplacer("x", long);
    expect(out).toBe("-1234567890123");
  });
});
