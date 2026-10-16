import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  writePkNickname,
  createPkNicknameStore,
  resolvePendingPkNicknames,
  PK_NICKNAME_CACHE_LIMIT,
} from "../src/index";
import type { PkNicknameStore } from "../src/index";

/**
 * `writePkNickname` 的来源优先级与返回值契约。
 *
 * ## 为什么这个返回值是承重的
 * 昵称有**两份独立状态**：
 * - `store.cache`（录制器，按直播场次隔离）：查询决策用，带来源优先级
 * - `pkUserNicknames`（XmlStreamController）：最终写进 XML 的映射表，last-write-wins
 *
 * 如果调用方不看返回值、无条件 `registerPkNickname`，就会出现：缓存里保留着
 * battle 的**权威**昵称，映射表却被**迟到的 api 兜底结果**覆盖 —— 与
 * `writePkNickname` 自身的优先级意图相矛盾。
 *
 * 所以这些用例守的是「被拒写时必须返回 false」这个前提；调用点是否真的用了它的
 * 返回值，只能靠代码审查（调用点在工厂闭包里，未导出）。
 */
describe("writePkNickname: 来源优先级与返回值", () => {
  let store: PkNicknameStore;
  beforeEach(() => {
    store = createPkNicknameStore();
  });

  it("首次写入返回 true", () => {
    expect(writePkNickname(store, "wpn-first", "主播甲", "api")).toBe(true);
  });

  it("已有 battle 权威昵称时，api 写入被拒并返回 false", () => {
    expect(writePkNickname(store, "wpn-blocked", "权威昵称", "battle")).toBe(true);
    // 这一条就是修复所依赖的前提：返回 false 时调用方不得登记映射表
    expect(writePkNickname(store, "wpn-blocked", "兜底昵称", "api")).toBe(false);
  });

  it("api 先写入后，battle 仍可覆盖并返回 true（覆盖方向正确）", () => {
    expect(writePkNickname(store, "wpn-override", "兜底昵称", "api")).toBe(true);
    expect(writePkNickname(store, "wpn-override", "权威昵称", "battle")).toBe(true);
  });

  it("同来源重复写入视为更新（返回 true）", () => {
    expect(writePkNickname(store, "wpn-same", "甲", "battle")).toBe(true);
    expect(writePkNickname(store, "wpn-same", "乙", "battle")).toBe(true);
  });

  it("空 uid 或空昵称不写入", () => {
    expect(writePkNickname(store, "", "主播甲", "api")).toBe(false);
    expect(writePkNickname(store, "wpn-empty", "", "api")).toBe(false);
  });
});

/**
 * 淘汰策略（P2-3 改进）：`store.cache` 按 **LRU** 淘汰，而非"最早插入先淘汰"。
 *
 * 旧实现直接用 `Map` 的插入顺序取 `keys().next()` —— 一旦某 uid 在很早就写入、之后
 * 即使被反复更新/命中，它仍最先被淘汰。改进后写入与只读命中都会把条目挪到末尾。
 */
describe("writePkNickname: LRU 淘汰", () => {
  const fill = (s: PkNicknameStore, n: number) => {
    for (let i = 0; i < n; i++) writePkNickname(s, `uid-${i}`, `n-${i}`, "api");
  };

  it("满额后淘汰「最久未使用」，而不是「最早插入」", () => {
    const s = createPkNicknameStore();
    fill(s, PK_NICKNAME_CACHE_LIMIT);
    expect(s.cache.size).toBe(PK_NICKNAME_CACHE_LIMIT);

    // uid-0 是最早插入的，但此刻刷新它 → 成为「最近使用」
    writePkNickname(s, "uid-0", "n-0-refreshed", "api");
    // 再插一个新键 → 应淘汰次早的 uid-1，而不是刚被刷新的 uid-0
    writePkNickname(s, "uid-new", "n-new", "api");

    expect(s.cache.has("uid-0")).toBe(true);
    expect(s.cache.get("uid-0")?.nickname).toBe("n-0-refreshed");
    expect(s.cache.has("uid-1")).toBe(false);
    expect(s.cache.has("uid-new")).toBe(true);
    expect(s.cache.size).toBe(PK_NICKNAME_CACHE_LIMIT);
  });

  it("只读命中（resolvePendingPkNicknames）也算「最近使用」", async () => {
    const s = createPkNicknameStore();
    fill(s, PK_NICKNAME_CACHE_LIMIT);

    // 仅"读"一次（不带写入路径），也应刷新使用顺序
    const r = await resolvePendingPkNicknames(s, ["uid-0"], { query: vi.fn() });
    expect(r.get("uid-0")).toBe("n-0");

    writePkNickname(s, "uid-new", "n-new", "api");
    expect(s.cache.has("uid-0")).toBe(true);
    expect(s.cache.has("uid-1")).toBe(false);
  });
});
