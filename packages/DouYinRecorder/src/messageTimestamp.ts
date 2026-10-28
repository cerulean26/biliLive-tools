/**
 * 把抖音消息里的「服务端时间字段」归一成毫秒；不可信时回落到本地时间。
 *
 * ## 为什么需要单独一个函数
 *
 * 同一条规律在四个消息处理器和三个消息构造函数里各写了一遍，而且四种写法互不一致：
 * `chat` 是「默认 Date.now() + 真值守卫」，`screenChat` 是三元且无守卫，`gift` 是
 * 「先算候选值再三元」且无守卫，`privilegeScreenChat` 干脆硬编码本地时间。
 * 其中 `createTime` / `eventTime` 缺失时，`Number(undefined)` 会得到 `NaN`，
 * 而旧代码里的 `Number(x ?? 0)` 则把它折成合法的 `0` —— 后者更糟：`0 * 1000` 写出
 * `ts="0"`，节点静默排到时间线最前，看不出哪里错了。
 *
 * ## 两条判据
 *
 * 1. **按数值判断，不按真值判断。** `toJSON()` 后 uint64 是字符串，`"0"` 是 truthy，
 *    `if (msg.createTime)` 挡不住它。
 * 2. **单位由调用方显式声明。** 实测三种单位并存：`chat.eventTime` 是秒、
 *    `screenChat.eventTime` 是纳秒、`createTime` 的秒/毫秒混用。靠数值量级去猜不可靠。
 *
 * @param raw 服务端时间字段（`toJSON()` 后通常是字符串，也可能是数字）
 * @param opts.useServerTimestamp 关闭时直接返回 `now`，与 `Recorder` 的开关语义一致
 * @param opts.unit `"s"` / `"ms"` / `"ns"`；默认 `"ms"`，并在秒/毫秒间自动判别
 * @param opts.now 回落值；默认 `Date.now()`，测试可注入固定值
 */
export function resolveTimestamp(
  raw: string | number | undefined,
  opts: {
    useServerTimestamp: boolean;
    unit?: "s" | "ms" | "ns";
    now?: number;
  },
): number {
  const now = opts.now ?? Date.now();
  if (!opts.useServerTimestamp) return now;

  const n = Number(raw ?? 0);
  // 缺失 / 空串 / "0" / 0 / 负数 / NaN / Infinity 一律视为「没有可用值」
  if (!Number.isFinite(n) || n <= 0) return now;

  if (opts.unit === "s") return n * 1000;
  if (opts.unit === "ns") return n / 1_000_000;
  // unit === "ms"：createTime 实测存在秒级与毫秒级两种口径，用 1e10 作分界
  return n > 9_999_999_999 ? n : n * 1000;
}
