import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoomRawLogger } from "../src/index";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 回归护栏：人数消息转储的**按输出文件隔离**与**开关**语义。
 *
 * 与 `createPkRawLogger` 同构，差异只有文件名后缀 `_room_raw.jsonl`。
 * 测试直接 import 真实实现，不复制逻辑。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roomraw-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 读取 jsonl，返回每行 [tag, payload.n] */
const readRows = async (p: string): Promise<[string, number][]> =>
  (await readFile(p, "utf-8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const r = JSON.parse(l);
      return [r.tag, r.payload.n] as [string, number];
    });

describe("createRoomRawLogger：按输出文件隔离", () => {
  it("两个会话（两个实例）各自成文件，互不串台", async () => {
    const a = createRoomRawLogger(true);
    const b = createRoomRawLogger(true);
    const vA = join(dir, "A");
    const vB = join(dir, "B");

    await a(vA, "roomStats", { n: 1 });
    await b(vB, "roomUserSeq", { n: 2 });
    await a(vA, "roomStats", { n: 3 });

    expect(await readRows(`${vA}_room_raw.jsonl`)).toEqual([
      ["roomStats", 1],
      ["roomStats", 3],
    ]);
    expect(await readRows(`${vB}_room_raw.jsonl`)).toEqual([["roomUserSeq", 2]]);
  });

  it("同一路径重复写：首条覆盖建文件，后续追加、不丢已写行", async () => {
    const a = createRoomRawLogger(true);
    const v = join(dir, "C");
    await a(v, "t", { n: 1 });
    await a(v, "t", { n: 2 });
    await a(v, "t", { n: 3 });
    expect(await readRows(`${v}_room_raw.jsonl`)).toEqual([
      ["t", 1],
      ["t", 2],
      ["t", 3],
    ]);
  });

  it("同一写入器被复用于新路径：新路径独立成文件，旧文件保留", async () => {
    const a = createRoomRawLogger(true);
    const v1 = join(dir, "D1");
    const v2 = join(dir, "D2");
    await a(v1, "t", { n: 1 });
    await a(v2, "t", { n: 2 });
    expect(await readRows(`${v1}_room_raw.jsonl`)).toEqual([["t", 1]]);
    expect(await readRows(`${v2}_room_raw.jsonl`)).toEqual([["t", 2]]);
  });

  it("创建失败后可重试（父目录不存在 → 仅告警，不抛）", async () => {
    const a = createRoomRawLogger(true);
    const bad = join(dir, "no-such-subdir", "X");
    await expect(a(bad, "t", { n: 1 })).resolves.toBeUndefined();

    const good = join(dir, "Y");
    await a(good, "t", { n: 2 });
    expect(await readRows(`${good}_room_raw.jsonl`)).toEqual([["t", 2]]);
  });

  it("videoPath 缺失时不创建任何文件", async () => {
    const a = createRoomRawLogger(true);
    await a(undefined, "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });
});

/**
 * 开关（默认关闭）：`roomStats` 约 0.6 秒一条，转储不该默认落在用户视频目录。
 */
describe("createRoomRawLogger：开关", () => {
  it('未开启（环境变量非 "1"）→ 连文件都不创建', async () => {
    // 显式置空而非依赖「环境里恰好没设」，使用例与实际运行环境无关、可复现
    vi.stubEnv("BILILIVE_TOOLS_ROOM_RAW_LOG", "");
    const a = createRoomRawLogger();
    await a(join(dir, "off"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('环境变量为 "0" 等其他值同样不开启（只有精确的 "1" 才算开启）', async () => {
    vi.stubEnv("BILILIVE_TOOLS_ROOM_RAW_LOG", "0");
    const a = createRoomRawLogger();
    await a(join(dir, "zero"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("BILILIVE_TOOLS_ROOM_RAW_LOG=1 → 开启并正常落盘", async () => {
    vi.stubEnv("BILILIVE_TOOLS_ROOM_RAW_LOG", "1");
    const a = createRoomRawLogger();
    const v = join(dir, "on");
    await a(v, "roomStats", { n: 1 });
    expect(existsSync(`${v}_room_raw.jsonl`)).toBe(true);
    expect(await readRows(`${v}_room_raw.jsonl`)).toEqual([["roomStats", 1]]);
  });

  it("环境变量在**创建写入器时**读取：同一进程内先关后开可切换", async () => {
    vi.stubEnv("BILILIVE_TOOLS_ROOM_RAW_LOG", "");
    const off = createRoomRawLogger();
    await off(join(dir, "first"), "t", { n: 1 });
    expect(await readdir(dir)).toEqual([]);

    vi.stubEnv("BILILIVE_TOOLS_ROOM_RAW_LOG", "1");
    const on = createRoomRawLogger();
    const v = join(dir, "second");
    await on(v, "t", { n: 2 });
    expect(await readRows(`${v}_room_raw.jsonl`)).toEqual([["t", 2]]);
  });
});
