import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPkRawLogger } from "../src/index";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 回归护栏：PK 原始日志写入器的**按输出文件隔离**（P1 修复）。
 *
 * 旧实现把「文件路径 / 就绪 Promise」放在模块顶层，导致同进程内第 2 次录制、
 * 或另一房间的录制器，都把日志写进**第 1 次录制**的文件（跨会话串台）。
 * 现改为 `createPkRawLogger(true)` 产出独立实例 —— 测试直接 import 真实实现，
 * 用「两个实例 → 两个文件」证明隔离生效。
 *
 * 另覆盖**开关**语义：默认关闭（读环境变量 `BILILIVE_TOOLS_PK_RAW_LOG`），
 * 关闭时连文件都不创建。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pkraw-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 读取 jsonl，返回每行 payload.n */
const readNums = async (p: string): Promise<number[]> =>
  (await readFile(p, "utf-8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).payload.n);

describe("createPkRawLogger：按输出文件隔离", () => {
  it("两个会话（两个 videoPath / 两个实例）各自成文件，互不串台", async () => {
    const a = createPkRawLogger(true);
    const b = createPkRawLogger(true);
    const vA = join(dir, "A");
    const vB = join(dir, "B");

    await a(vA, "linkMic", { n: 1 });
    await b(vB, "linkMic", { n: 2 });
    await a(vA, "linkMic", { n: 3 });

    expect(existsSync(`${vA}_pk_raw.jsonl`)).toBe(true);
    expect(existsSync(`${vB}_pk_raw.jsonl`)).toBe(true);
    // 关键：A 的两行都在 A 的文件里（旧实现会让 A 的第 1 行被 B/后续覆盖丢失）
    expect(await readNums(`${vA}_pk_raw.jsonl`)).toEqual([1, 3]);
    expect(await readNums(`${vB}_pk_raw.jsonl`)).toEqual([2]);
  });

  it("同一路径重复写：只创建一次（覆盖写），后续为追加、不丢已写行", async () => {
    const a = createPkRawLogger(true);
    const v = join(dir, "C");
    await a(v, "t", { n: 1 });
    await a(v, "t", { n: 2 });
    await a(v, "t", { n: 3 });
    expect(await readNums(`${v}_pk_raw.jsonl`)).toEqual([1, 2, 3]);
  });

  it("同一写入器被复用于新路径：新路径独立成文件，旧文件保留", async () => {
    const a = createPkRawLogger(true);
    const v1 = join(dir, "D1");
    const v2 = join(dir, "D2");
    await a(v1, "t", { n: 1 });
    await a(v2, "t", { n: 2 });
    expect(await readNums(`${v1}_pk_raw.jsonl`)).toEqual([1]);
    expect(await readNums(`${v2}_pk_raw.jsonl`)).toEqual([2]);
  });

  it("创建失败后可重试（不会让本会话原始日志永久失效）", async () => {
    const a = createPkRawLogger(true);
    // 父目录不存在 → writeFile 失败（仅告警，不抛）
    const bad = join(dir, "no-such-subdir", "X");
    await expect(a(bad, "t", { n: 1 })).resolves.toBeUndefined();
    // 换到合法路径应能重建（旧实现会因已拒绝的 promise 永久失效）
    const good = join(dir, "Y");
    await a(good, "t", { n: 2 });
    expect(await readNums(`${good}_pk_raw.jsonl`)).toEqual([2]);
  });

  it("videoPath 缺失时不创建任何文件", async () => {
    const a = createPkRawLogger(true);
    await a(undefined, "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });
});

/**
 * 开关（默认关闭）：调试产物不该默认落在用户视频目录 ——
 * 单场约 160 KB，与 XML 同量级。
 */
describe("createPkRawLogger：开关", () => {
  it('未开启（环境变量非 "1"）→ 连文件都不创建', async () => {
    // 显式置空而非依赖「环境里恰好没设」，使用例与实际运行环境无关、可复现
    vi.stubEnv("BILILIVE_TOOLS_PK_RAW_LOG", "");
    const a = createPkRawLogger();
    await a(join(dir, "off"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('环境变量为 "0" 等其他值同样不开启（只有精确的 "1" 才算开启）', async () => {
    vi.stubEnv("BILILIVE_TOOLS_PK_RAW_LOG", "0");
    const a = createPkRawLogger();
    await a(join(dir, "zero"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("BILILIVE_TOOLS_PK_RAW_LOG=1 → 开启并正常落盘", async () => {
    vi.stubEnv("BILILIVE_TOOLS_PK_RAW_LOG", "1");
    const a = createPkRawLogger();
    const v = join(dir, "on");
    await a(v, "t", { n: 1 });
    expect(await readNums(`${v}_pk_raw.jsonl`)).toEqual([1]);
  });

  it("环境变量在**创建写入器时**读取：同一进程内先关后开可切换", async () => {
    vi.stubEnv("BILILIVE_TOOLS_PK_RAW_LOG", "");
    const off = createPkRawLogger();
    await off(join(dir, "first"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);

    vi.stubEnv("BILILIVE_TOOLS_PK_RAW_LOG", "1");
    const on = createPkRawLogger();
    const v = join(dir, "second");
    await on(v, "t", { n: 2 });
    expect(await readNums(`${v}_pk_raw.jsonl`)).toEqual([2]);
  });
});
