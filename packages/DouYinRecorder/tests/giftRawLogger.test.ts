import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createGiftRawLogger } from "../src/index";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 回归护栏：礼物原始日志写入器。
 *
 * 与 `pkRawLogger.test.ts` 覆盖同一套语义，但不能互相替代 —— 两者是**两个独立函数**，
 * 礼物这份当初是临时调试实现、默认 `enabled = true`（每次录制都在视频目录落一个
 * 单场可达 2 MB 的文件），本用例专门守住「改为默认关闭」这一条不被退回。
 *
 * 另覆盖**按输出文件隔离**（与 PK 同源的跨会话串台问题）。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "giftraw-"));
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

describe("createGiftRawLogger：按输出文件隔离", () => {
  it("两个会话（两个 videoPath / 两个实例）各自成文件，互不串台", async () => {
    const a = createGiftRawLogger(true);
    const b = createGiftRawLogger(true);
    const vA = join(dir, "A");
    const vB = join(dir, "B");

    await a(vA, "gift", { n: 1 });
    await b(vB, "gift", { n: 2 });
    await a(vA, "gift", { n: 3 });

    expect(existsSync(`${vA}_gift_raw.jsonl`)).toBe(true);
    expect(existsSync(`${vB}_gift_raw.jsonl`)).toBe(true);
    expect(await readNums(`${vA}_gift_raw.jsonl`)).toEqual([1, 3]);
    expect(await readNums(`${vB}_gift_raw.jsonl`)).toEqual([2]);
  });

  it("同一写入器被复用于新路径：新路径独立成文件，旧文件保留", async () => {
    const a = createGiftRawLogger(true);
    const v1 = join(dir, "D1");
    const v2 = join(dir, "D2");
    await a(v1, "gift", { n: 1 });
    await a(v2, "gift", { n: 2 });
    expect(await readNums(`${v1}_gift_raw.jsonl`)).toEqual([1]);
    expect(await readNums(`${v2}_gift_raw.jsonl`)).toEqual([2]);
  });

  it("videoPath 缺失时不创建任何文件", async () => {
    const a = createGiftRawLogger(true);
    await a(undefined, "gift", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });
});

/**
 * 开关（默认关闭）：礼物通常是全场条数最多的消息，单行约 2 KB
 * （实测 1017 条 ≈ 2.0 MB），调试产物不该默认落在用户视频目录。
 */
describe("createGiftRawLogger：开关", () => {
  it('未开启（环境变量非 "1"）→ 连文件都不创建', async () => {
    vi.stubEnv("BILILIVE_TOOLS_GIFT_RAW_LOG", "");
    const a = createGiftRawLogger();
    await a(join(dir, "off"), "gift", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('环境变量为 "0" 等其他值同样不开启（只有精确的 "1" 才算开启）', async () => {
    vi.stubEnv("BILILIVE_TOOLS_GIFT_RAW_LOG", "0");
    const a = createGiftRawLogger();
    await a(join(dir, "zero"), "gift", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("BILILIVE_TOOLS_GIFT_RAW_LOG=1 → 开启并正常落盘", async () => {
    vi.stubEnv("BILILIVE_TOOLS_GIFT_RAW_LOG", "1");
    const a = createGiftRawLogger();
    const v = join(dir, "on");
    await a(v, "gift", { n: 1 });
    expect(await readNums(`${v}_gift_raw.jsonl`)).toEqual([1]);
  });

  it("环境变量在**创建写入器时**读取：同一进程内先关后开可切换", async () => {
    vi.stubEnv("BILILIVE_TOOLS_GIFT_RAW_LOG", "");
    const off = createGiftRawLogger();
    await off(join(dir, "first"), "gift", { n: 1 });
    expect(await readdir(dir)).toEqual([]);

    vi.stubEnv("BILILIVE_TOOLS_GIFT_RAW_LOG", "1");
    const on = createGiftRawLogger();
    const v = join(dir, "second");
    await on(v, "gift", { n: 2 });
    expect(await readNums(`${v}_gift_raw.jsonl`)).toEqual([2]);
  });
});
