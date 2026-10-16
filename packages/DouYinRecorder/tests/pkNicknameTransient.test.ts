import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  routePkNicknameResult,
  resolvePendingPkNicknames,
  writePkNickname,
  createPkNicknameStore,
  getPkNicknameStore,
  buildPkNicknameStoreKey,
  PK_NICKNAME_FLUSH_WAIT_TIMEOUT,
} from "../src/index.js";
import type { PkNicknameStore } from "../src/index.js";
import { classifyProfileResponse } from "../src/douyin_api.js";

/**
 * PK 昵称查询全链路（D1 根因：失败不得被当成 not_found）。
 *
 * 覆盖同一链路的两个单元：
 *   - `getUserNickname`（douyin_api.ts）：网络层产出 `{ found | not_found | unavailable }`
 *   - `routePkNicknameResult`（index.ts）：消费该结果，写入对应状态
 *
 * ⚠️ 设计上**不做任何自动重试**：任何失败都只是「本次未取到」，记入 `store.failed` 后
 * 本会话不再查 —— 持续故障下反复打接口会触发风控，而封 IP 不可逆。需要重查由用户重启程序。
 */

// ── getUserNickname 的网络隔离 ─────────────────────────────────────────────
// mock axios，使 ttwid(post) 与 profile(get) 均可控。vi.mock 工厂被提升，
// 需通过 vi.hoisted 暴露可被工厂引用的 mock。
const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: Object.assign((config?: unknown) => getMock(config), {
    // axios.create 返回的实例 = douyin_api 的 requester：get 查 profile、post 注册 ttwid。
    // default 上不挂 post —— 生产代码一律走实例（proxy:false），若退回裸 axios.post 会在此暴露。
    create: () => ({ get: getMock, post: postMock }),
  }),
}));

// ⚠️ 必须从「每次 resetModules 后的新实例」取：静态 import 绑定的是**初始实例**，
// 与 beforeEach 动态导入的实例不共享模块级状态（ttwidCache 会是两个不同的变量）。
let getUserNickname: typeof import("../src/douyin_api.js").getUserNickname;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  // 默认：ttwid 正常下发、profile 返回昵称；单个用例再覆盖
  postMock.mockResolvedValue({ headers: { "set-cookie": ["ttwid=abc; Path=/;"] } });
  getMock.mockResolvedValue({ data: { user: { nickname: "张三" } } });
  const mod = await import("../src/douyin_api.js");
  getUserNickname = mod.getUserNickname;
});

// ===========================================================================
// 段 1 · getUserNickname：产出结构化结果（生产者）
// ===========================================================================
describe("getUserNickname 结构化结果（D1 根因：失败不得被当成 not_found）", () => {
  it("响应带 user.nickname → found", async () => {
    const r = await getUserNickname("123");
    expect(r).toEqual({ status: "found", nickname: "张三" });
  });

  it("实测形态 status_code=3170 + user 占位对象（真·查无此人）→ not_found", async () => {
    // 真实响应（实测，uid 查不到时）：user 是字段全 null 的占位对象、无 nickname
    getMock.mockResolvedValue({
      data: {
        status_code: 3170,
        user: {
          city: null,
          country: null,
          district: null,
          gender: null,
          province: null,
          school_name: null,
          user_age: null,
        },
      },
    });
    expect(await getUserNickname("123")).toEqual({ status: "not_found" });
  });

  it("实测形态 status_code=2（user 空对象；UserId 不合法）→ not_found", async () => {
    getMock.mockResolvedValue({ data: { status_code: 2, user: {} } });
    expect(await getUserNickname("123")).toEqual({ status: "not_found" });
  });

  it("实测形态「完全空响应」→ unavailable（**不得**判死）", async () => {
    // 实测：不带 / 伪造 ttwid → HTTP 200 + 完全空响应（len=0），axios 给的是 `""` 而非 `{}`
    getMock.mockResolvedValue({ data: "" });
    expect(await getUserNickname("123")).toEqual({ status: "unavailable" });
  });

  it("ttwid 拿不到 → unavailable，且不发 profile 请求", async () => {
    postMock.mockResolvedValue({ headers: {} }); // 无 set-cookie → getTtwid 返回 ""
    expect(await getUserNickname("123")).toEqual({ status: "unavailable" });
    expect(getMock).not.toHaveBeenCalled();
  });

  it("单次请求，**不重试**：响应体异常也只查一次", async () => {
    getMock.mockResolvedValue({ data: "" });
    expect(await getUserNickname("123")).toEqual({ status: "unavailable" });
    expect(getMock).toHaveBeenCalledTimes(1); // 核心：不把失败放大成请求风暴
    expect(postMock).toHaveBeenCalledTimes(1); // ttwid 也只注册一次
  });

  it("注册成功后复用缓存：后续查询不再注册", async () => {
    await getUserNickname("a");
    await getUserNickname("b");
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("注册失败不缓存：下一次调用会重新注册（否则一次失败毒化后续全部查询）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      postMock
        .mockResolvedValueOnce({ headers: {} }) // 第 1 次：无 set-cookie → 失败
        .mockResolvedValueOnce({ headers: { "set-cookie": ["ttwid=ok; Path=/;"] } }); // 第 2 次：成功

      expect(await getUserNickname("a")).toEqual({ status: "unavailable" });
      expect(await getUserNickname("b")).toEqual({ status: "found", nickname: "张三" });
      expect(postMock).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("并发查询共享同一次注册（缓存的是 Promise，天然去重）", async () => {
    const r = await Promise.all([getUserNickname("a"), getUserNickname("b"), getUserNickname("c")]);
    expect(postMock).toHaveBeenCalledTimes(1); // 三个并发只注册一次
    expect(getMock).toHaveBeenCalledTimes(3);
    expect(r.every((x) => x.status === "found")).toBe(true);
  });

  it("超时 / 5xx / 429 / 4xx —— 一律 unavailable（HTTP 状态码不参与分类）", async () => {
    // 实测六次真实请求全部是 HTTP 200 + 业务码，HTTP 错误码从未观测到；
    // 既然没有依据区分它们的去留，就不分类（回归「失败即失败」）。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cases = [
        new Error("ETIMEDOUT"),
        Object.assign(new Error("boom"), { response: { status: 500 } }),
        Object.assign(new Error("boom"), { response: { status: 429 } }),
        Object.assign(new Error("boom"), { response: { status: 403 } }),
        Object.assign(new Error("boom"), { response: { status: 404 } }),
      ];
      for (const e of cases) {
        getMock.mockRejectedValueOnce(e);
        expect(await getUserNickname("123")).toEqual({ status: "unavailable" });
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("profile 请求超时必须 ≤ 整批等待预算（否则慢请求会拖住同 chunk 的其它 uid）", async () => {
    await getUserNickname("123");
    // getMock 即 requester.get，签名 (url, config)；profile 请求是本函数唯一一次 get
    const [, config] = getMock.mock.calls[0] as [string, { timeout?: number }];
    expect(typeof config.timeout).toBe("number");
    // 0 / undefined 在 axios 里表示「不超时」，会让慢请求无限期占住并发块
    expect(config.timeout!).toBeGreaterThan(0);
    expect(config.timeout!).toBeLessThanOrEqual(PK_NICKNAME_FLUSH_WAIT_TIMEOUT);
  });
});

// ===========================================================================
// 段 2 · routePkNicknameResult（消费者：结果分流）
// ===========================================================================
describe("routePkNicknameResult（结果分流）", () => {
  const handlers = (calls: string[]) => ({
    onFound: () => calls.push("found"),
    onNotFound: () => calls.push("notFound"),
    onUnavailable: () => calls.push("unavailable"),
  });

  it("found → 只调用 onFound", () => {
    const calls: string[] = [];
    routePkNicknameResult({ status: "found", nickname: "x" }, handlers(calls));
    expect(calls).toEqual(["found"]);
  });

  it("not_found → 只调用 onNotFound", () => {
    const calls: string[] = [];
    routePkNicknameResult({ status: "not_found" }, handlers(calls));
    expect(calls).toEqual(["notFound"]);
  });

  it("unavailable → 只调用 onUnavailable（不得走 onNotFound，避免把失败当成「查无此人」）", () => {
    const calls: string[] = [];
    routePkNicknameResult({ status: "unavailable" }, handlers(calls));
    expect(calls).toEqual(["unavailable"]);
  });
});

// ===========================================================================
// 段 3 · classifyProfileResponse（纯函数：按响应体分流）
//   形态全部来自真实请求（见报告附录）。
// ===========================================================================
describe("classifyProfileResponse（按响应体分流）", () => {
  it("status_code=0 且有 nickname → found", () => {
    expect(
      classifyProfileResponse({ status_code: 0, user: { nickname: "迪士尼在逃公主👸" } }),
    ).toEqual({ status: "found", nickname: "迪士尼在逃公主👸" });
  });

  it("status_code=3170（user 占位对象、无 nickname）→ not_found", () => {
    expect(
      classifyProfileResponse({ status_code: 3170, user: { city: null, gender: null } }),
    ).toEqual({ status: "not_found" });
  });

  it("status_code=2（user 空对象；实测形态：UserId 不合法）→ not_found", () => {
    expect(classifyProfileResponse({ status_code: 2, user: {} })).toEqual({ status: "not_found" });
  });

  it("nickname 键存在但值为空串 / null → unavailable（数据异常，不得判死）", () => {
    expect(classifyProfileResponse({ status_code: 0, user: { nickname: "" } })).toEqual({
      status: "unavailable",
    });
    expect(classifyProfileResponse({ status_code: 0, user: { nickname: null } })).toEqual({
      status: "unavailable",
    });
  });

  it('空 body → unavailable（含实测形态：完全空响应被 axios 解析为 `""`）', () => {
    expect(classifyProfileResponse("")).toEqual({ status: "unavailable" });
    expect(classifyProfileResponse({})).toEqual({ status: "unavailable" });
    expect(classifyProfileResponse(undefined)).toEqual({ status: "unavailable" });
  });

  it("未知 status_code → unavailable（保守：宁可漏判也不判死）", () => {
    expect(classifyProfileResponse({ status_code: 9999 })).toEqual({ status: "unavailable" });
  });

  it("未知 status_code **带 user** 也 → unavailable（不得因「user 存在」就判永久失败）", () => {
    expect(classifyProfileResponse({ status_code: 9999, user: { foo: 1 } })).toEqual({
      status: "unavailable",
    });
  });

  it("成功码却无 nickname → unavailable（成功却没数据，更像服务端异常 / 降级）", () => {
    expect(classifyProfileResponse({ status_code: 0, user: { city: null } })).toEqual({
      status: "unavailable",
    });
  });
});

/**
 * flush 前批量补齐昵称（批式改造）。
 *
 * 录制期间**不再即时查询**：分数消息只登记 uid，查询集中到 flush 前调用本函数。
 * 因此它同时承担两件事：
 *  - 已有结果（battle 覆盖 / 在途返回 / 不再查询的 uid）一律不重复请求 —— 这是「消除白查」的落点；
 *  - 查询发生在快照之前，根除「结果落盘后才回来、被 hasCompleted 丢弃」的竞态。
 */
describe("resolvePendingPkNicknames: flush 前批量补齐昵称", () => {
  let store: PkNicknameStore;
  beforeEach(() => {
    store = createPkNicknameStore();
  });

  it("空 uids → 空 Map，且不发起查询", async () => {
    const query = vi.fn();
    expect((await resolvePendingPkNicknames(store, [], { query })).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("缓存命中（如 battle 已覆盖）直接用，**不发起查询** —— 有 battle 的场次零请求", async () => {
    writePkNickname(store, "u1", "battle 给的昵称", "battle");
    const query = vi.fn(async () => ({ status: "found", nickname: "不该被查到" }) as const);
    const r = await resolvePendingPkNicknames(store, ["u1"], { query });
    expect(query).not.toHaveBeenCalled(); // ← 核心：命中即不查（消除白查）
    expect(r.get("u1")).toBe("battle 给的昵称");
  });

  it("不再查询的 uid 跳过，不重复查询", async () => {
    store.failed.add("u2");
    const query = vi.fn();
    expect((await resolvePendingPkNicknames(store, ["u2"], { query })).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("未命中才查询：found 写入缓存（source=api）并返回", async () => {
    const query = vi.fn(async () => ({ status: "found", nickname: "新查到的" }) as const);
    const r = await resolvePendingPkNicknames(store, ["u3"], { query });
    expect(query).toHaveBeenCalledWith("u3");
    expect(r.get("u3")).toBe("新查到的");
    expect(store.cache.get("u3")?.nickname).toBe("新查到的");
    expect(store.cache.get("u3")?.source).toBe("api");
  });

  it("多个 uid 一次批量查完", async () => {
    const query = vi.fn(
      async (uid: string) => ({ status: "found", nickname: `nick-${uid}` }) as const,
    );
    const r = await resolvePendingPkNicknames(store, ["a", "b", "c"], { query });
    expect(query).toHaveBeenCalledTimes(3);
    expect(r.size).toBe(3);
    expect(r.get("b")).toBe("nick-b");
  });

  it("unavailable → 不返回、记入不再查询；**第二次 flush 不再发请求**（不做重试）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const query = vi.fn(async () => ({ status: "unavailable" }) as const);
      const first = await resolvePendingPkNicknames(store, ["u4"], { query });
      expect(first.size).toBe(0);
      expect(store.failed.has("u4")).toBe(true);

      const second = await resolvePendingPkNicknames(store, ["u4"], { query });
      expect(second.size).toBe(0);
      expect(query).toHaveBeenCalledTimes(1); // 核心：不重试，避免持续故障下反复打接口
    } finally {
      warn.mockRestore();
    }
  });

  it("not_found → 记入不再查询并告警一次，之后不再查询", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const query = vi.fn(async () => ({ status: "not_found" }) as const);
      await resolvePendingPkNicknames(store, ["u5"], { query });
      await resolvePendingPkNicknames(store, ["u5"], { query });
      expect(store.failed.has("u5")).toBe(true);
      expect(store.warnedFailed.has("u5")).toBe(true);
      expect(query).toHaveBeenCalledTimes(1); // 第二次被跳过
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("服务端确认不存在"));
    } finally {
      warn.mockRestore();
    }
  });

  it("查询异常（query reject）也不会漏掉后续 uid", async () => {
    const query = vi.fn(async (uid: string) => {
      if (uid === "boom") throw new Error("网络炸了");
      return { status: "found", nickname: `nick-${uid}` } as const;
    });
    const r = await resolvePendingPkNicknames(store, ["boom", "ok"], { query });
    expect(r.get("ok")).toBe("nick-ok");
  });

  it("总超时：查询卡住时不拖住收尾", async () => {
    const query = vi.fn(() => new Promise<never>(() => {}));
    const started = Date.now();
    const r = await resolvePendingPkNicknames(store, ["u6"], { query, timeoutMs: 80 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.size).toBe(0);
  });

  it("会先在途查询收尾、再回读缓存（等待是承重的）", async () => {
    let settled = false;
    const inflight = new Promise<void>((resolve) => {
      setTimeout(() => {
        writePkNickname(store, "u7", "在途返回的", "api");
        settled = true;
        resolve();
      }, 30);
    });
    const query = vi.fn();
    const r = await resolvePendingPkNicknames(store, ["u7"], {
      inflight: [inflight],
      timeoutMs: 3_000,
      query,
    });
    expect(settled).toBe(true);
    expect(r.get("u7")).toBe("在途返回的");
    expect(query).not.toHaveBeenCalled(); // 在途已带回，无需再查
  });

  it("无待查 uid 时立即返回（不应误等超时）", async () => {
    writePkNickname(store, "u8", "已有", "api");
    const started = Date.now();
    await resolvePendingPkNicknames(store, ["u8"], { timeoutMs: 3_000 });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("快速路径结束后会清掉总超时定时器（不留悬挂 timer）", async () => {
    // 正常（非超时）路径下 work 先完成；若不清掉 deadline 的定时器，
    // 它会继续存活最长 timeoutMs。用显式大 timeout 放大该差异，断言 clearTimeout 被调用。
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const query = vi.fn(async () => ({ status: "found", nickname: "瞬时返回" }) as const);
      const r = await resolvePendingPkNicknames(store, ["u9"], { query, timeoutMs: 60_000 });
      expect(r.get("u9")).toBe("瞬时返回");
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });
});

/**
 * 昵称状态按「直播场次」隔离（`${channelId}#${liveId}`）：
 * 跨场次不复用（昵称会随改名过期），同场次断线重连复用，多房间互不影响。
 */
describe("getPkNicknameStore: 按直播场次隔离", () => {
  it("不同场次的缓存互相不可见（不跨录制复用）", () => {
    const a = getPkNicknameStore(buildPkNicknameStoreKey("room1", "liveA"));
    const b = getPkNicknameStore(buildPkNicknameStoreKey("room1", "liveB"));
    expect(a).not.toBe(b);
    writePkNickname(a, "u", "旧场次的昵称", "api");
    expect(b.cache.has("u")).toBe(false);
  });

  it("同一场次（含断线重连）复用同一份状态", () => {
    const key = buildPkNicknameStoreKey("room1", "liveA");
    const first = getPkNicknameStore(key);
    writePkNickname(first, "u", "昵称", "battle");
    const again = getPkNicknameStore(key);
    expect(again).toBe(first);
    expect(again.cache.get("u")?.nickname).toBe("昵称");
  });

  it("不同直播间互不影响", () => {
    const a = getPkNicknameStore(buildPkNicknameStoreKey("room1", "liveX"));
    const b = getPkNicknameStore(buildPkNicknameStoreKey("room2", "liveX"));
    expect(a).not.toBe(b);
  });
});
