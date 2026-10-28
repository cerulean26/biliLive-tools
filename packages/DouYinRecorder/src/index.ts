import path from "node:path";
import fs from "node:fs";
import mitt from "mitt";
import {
  defaultFromJSON,
  defaultToJSON,
  genRecorderUUID,
  genRecordUUID,
  utils,
  createDownloader,
} from "@bililive-tools/manager";
import type {
  Recorder,
  RecorderCreateOpts,
  RecorderProvider,
  RecordHandle,
  Comment,
  GiveGift,
  Message,
} from "@bililive-tools/manager";

import { getInfo, getStream } from "./stream.js";
import { singleton } from "./utils.js";
import { resolveTimestamp } from "./messageTimestamp.js";
import {
  resolveShortURL,
  parseUser,
  getUserNickname,
  type GetUserNicknameResult,
} from "./douyin_api.js";
import {
  buildBattleKey,
  collectPkNicknames,
  createPkChannelTracker,
  normalizeUserInfosKeys,
} from "./pkNicknameCache.js";

import DouYinDanmaClient from "douyin-danma-listener";

import type { APIType } from "./types.js";

function createRecorder(opts: RecorderCreateOpts): Recorder {
  // 内部实现时，应该只有 proxy 包裹的那一层会使用这个 recorder 标识符，不应该有直接通过
  // 此标志来操作这个对象的地方，不然会跳过 proxy 的拦截。
  const recorder: Recorder = {
    id: opts.id ?? genRecorderUUID(),
    extra: opts.extra ?? {},
    // @ts-ignore
    ...mitt(),
    ...opts,

    availableStreams: [],
    availableSources: [],
    qualityRetry: opts.qualityRetry ?? 0,
    useServerTimestamp: opts.useServerTimestamp ?? true,
    state: "idle",
    cache: null as any,
    appendTimeline: null as any,

    getChannelURL() {
      return `https://live.douyin.com/${this.channelId}`;
    },
    checkLiveStatusAndRecord: singleton(checkLiveStatusAndRecord),

    toJSON() {
      return defaultToJSON(provider, this);
    },

    async getLiveInfo() {
      const channelId = this.channelId;
      const info = await getInfo(channelId, {
        auth: this.auth,
        uid: this.uid,
      });
      return {
        channelId,
        ...info,
      };
    },
    async getStream() {
      const res = await getStream({
        channelId: this.channelId,
        quality: this.quality,
        streamPriorities: this.streamPriorities,
        sourcePriorities: this.sourcePriorities,
        strictQuality: false,
        auth: this.auth,
        formatPriorities: this.formatPriorities,
        doubleScreen: this.doubleScreen,
        api: this.api as APIType,
        uid: this.uid,
      });
      return res.currentStream;
    },
  };

  const recorderWithSupportUpdatedEvent = new Proxy(recorder, {
    set(obj, prop, value) {
      Reflect.set(obj, prop, value);

      if (typeof prop === "string") {
        obj.emit("Updated", [prop]);
      }

      return true;
    },
  });

  return recorderWithSupportUpdatedEvent;
}

const ffmpegOutputOptions: string[] = [];
const ffmpegInputOptions: string[] = ["-rw_timeout", "10000000", "-timeout", "10000000"];

/**
 * PK 选手昵称缓存。
 *
 * proto 的 `UserScores` 消息里没有 nick_name 字段，昵称有两个来源：
 * - `battle`：PK 开始消息(WebcastLinkMicBattleMethod) 的 `userInfos`，PK 官方数据，权威；
 * - `api`：按 uid 调用 `getUserNickname` 反查，属于兜底补充。
 *
 * 声明在模块顶层而非函数体内：`checkLiveStatusAndRecord` 会被manager.ts 在
 * 定时检查(:300/:347) 与断线重连(:537) 时反复调用，函数级缓存每次都会重建、
 * 丢失已查到的昵称。模块级缓存随进程存活，跨录制复用（uid→昵称是稳定的映射）。
 *
 * 清理时机：仅随进程退出而释放。录制停止 / removeRecorder 都不清理，
 * 以免断线重连时丢缓存。若需限制体积，可按容量淘汰最旧的条目。
 */
type PkNicknameSource = "battle" | "api";

interface PkNicknameEntry {
  nickname: string;
  /** 该昵称的来源，用于排查与决定覆盖优先级 */
  source: PkNicknameSource;
  updatedAt: number;
}

/** 昵称来源优先级：battle 是 PK 官方数据，api 只是兜底，兜底不得覆盖权威 */
const PK_NICKNAME_PRIORITY: Record<PkNicknameSource, number> = { api: 1, battle: 2 };

/** 缓存上限，防止长期录制累积过多条目（每条约百字节）；满则按 LRU 淘汰 */
export const PK_NICKNAME_CACHE_LIMIT = 5000;

/**
 * 一场「直播场次」的 PK 昵称状态。
 *
 * 为什么按**场次**隔离、而不是进程级单例：昵称会随主播改名而过期，跨场次复用旧值会
 * 显示出错误昵称（即"缓存不可跨录制使用"）。同时也不能按"录制会话"（函数调用）隔离 ——
 * `checkLiveStatusAndRecord` 会被定时轮询反复调用，按调用隔离会让缓存几十秒就失效。
 *
 * 键取 `${channelId}#${liveId}`：既隔离不同直播场次，也隔离不同直播间（多房间同时
 * 录制互不影响）；同一场直播内的断线重连 liveId 不变、缓存得以保留。
 */
export interface PkNicknameStore {
  /** uid -> 昵称（带来源与更新时间） */
  cache: Map<string, PkNicknameEntry>;
  /**
   * 本会话**不再查询**的 uid。两类都记在这里：
   * - 服务端确认「查无此人」（`status_code` 3170 / 2）
   * - 本次未取到（ttwid / 网络 / HTTP / 响应体异常）
   *
   * 后果一致（都避免持续故障下反复打接口触发风控），但含义不同 ——
   * 前者是结论（重启也没用），后者只是一次没拿到（重启可重查）。告警措辞据此区分。
   */
  failed: Set<string>;
  /** 进行中的查询，用于同一 uid 的并发去重 */
  pending: Map<string, Promise<GetUserNicknameResult | null>>;
  /** 已就「未取到 / 查不到」提示过的 uid，避免刷屏 */
  warnedFailed: Set<string>;
}

/** 保留最近 N 个「直播场次」的昵称状态；超出淘汰最久未使用（LRU） */
const PK_NICKNAME_STORE_LIMIT = 8;

const pkNicknameStores = new Map<string, PkNicknameStore>();

/** 场次键：`${channelId}#${liveId}`；liveId 缺失时退化为按直播间隔离 */
export function buildPkNicknameStoreKey(channelId: string, liveId?: string): string {
  return `${channelId}#${liveId ?? "unknown"}`;
}

/** 新建一个空的场次昵称状态（供 `getPkNicknameStore` 与测试使用） */
export function createPkNicknameStore(): PkNicknameStore {
  return {
    cache: new Map(),
    failed: new Set(),
    pending: new Map(),
    warnedFailed: new Set(),
  };
}

/** 取（或懒创建）某场次的昵称状态；命中做 LRU touch，避免活跃场次被新场次挤掉 */
export function getPkNicknameStore(key: string): PkNicknameStore {
  const existing = pkNicknameStores.get(key);
  if (existing) {
    pkNicknameStores.delete(key);
    pkNicknameStores.set(key, existing);
    return existing;
  }
  const store = createPkNicknameStore();
  pkNicknameStores.set(key, store);
  while (pkNicknameStores.size > PK_NICKNAME_STORE_LIMIT) {
    const oldest = pkNicknameStores.keys().next();
    if (oldest.done) break;
    pkNicknameStores.delete(oldest.value);
  }
  return store;
}

/** 本会话不再查询的 uid 上限（D3：原无上限，长跑进程单调增长） */
const PK_NICKNAME_FAILED_LIMIT = 2000;
/** 已提示过「查不到昵称」的 uid 上限（D3） */
const PK_NICKNAME_WARNED_LIMIT = 2000;
/**
 * `flush` 前等待「在途昵称查询」的最长时间（ms）。
 *
 * 批量补齐昵称时会等待在途查询收尾；若某个查询卡住，不能被它拖住录制收尾。
 * 取值依据：api 通常 ~100ms（ttwid 注册可能再 +250ms），3s 足够富余。
 */
export const PK_NICKNAME_FLUSH_WAIT_TIMEOUT = 3_000;
/** flush 时批量补查的并发上限：兼顾速度与「不触发风控」 */
const PK_NICKNAME_FLUSH_CONCURRENCY = 4;

/**
 * 四路原始报文转储的开关环境变量。**只有值严格等于 `"1"` 才算开启**
 * （`0` / 空串 / 未设置都算关闭），与 `createJsonlRawLogger` 的 enabled 语义一致。
 *
 * 集中在这里的原因：开关名同时被「写入器默认值」与「全关时的汇总日志」使用，
 * 两处各写一份字符串会悄悄漂移（改名只改一处 ⇒ 汇总日志说的与实际不符）。
 */
const RAW_LOG_ENV_KEYS = {
  pk: "BILILIVE_TOOLS_PK_RAW_LOG",
  room: "BILILIVE_TOOLS_ROOM_RAW_LOG",
  rank: "BILILIVE_TOOLS_RANK_RAW_LOG",
  gift: "BILILIVE_TOOLS_GIFT_RAW_LOG",
} as const;

export type RawLogKind = keyof typeof RAW_LOG_ENV_KEYS;

/** 读取单路转储开关（`env` 参数只为便于测试，默认即真实 `process.env`） */
export function isRawLogEnabled(kind: RawLogKind, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RAW_LOG_ENV_KEYS[kind]] === "1";
}

/**
 * 四路**全部关闭**时返回要打印的一行提示，否则返回 `null`。
 *
 * 为什么需要：`createJsonlRawLogger` 只在**开启**时打日志，四路全关时日志里没有任何痕迹，
 * 「环境变量没传到进程」（打包版从图形界面启动时拿不到 shell 变量，这是最常见的情形）
 * 与「传到了但值是 `0`/空」完全无法区分。
 * 抽成纯函数是因为调用点在 `checkLiveStatusAndRecord` 里，直接断言不到。
 */
export function describeDisabledRawLogs(switches: Record<RawLogKind, boolean>): string | null {
  if ((Object.keys(switches) as RawLogKind[]).some((kind) => switches[kind])) return null;
  const names = Object.values(RAW_LOG_ENV_KEYS)
    .map((key) => key.replace("BILILIVE_TOOLS_", "").replace("_RAW_LOG", ""))
    .join(",");
  return `[rawLog] 四路原始报文转储均未启用（设置页「调试」四项均关，BILILIVE_TOOLS_{${names}}_RAW_LOG 亦非 "1"）`;
}

/**
 * 合成四路转储的最终开关：**设置页开关与环境变量取或**。
 *
 * - 设置页（`config.recorder.rawLog*`，全局、不按房间）是可发现、可达的主入口 ——
 *   打包版从图形界面启动时拿不到 shell 环境变量，只靠 env 等于没有入口；
 * - 环境变量只增不减：`"1"` 能强制打开（临时取证时不必进设置页），但**不能**关掉已打开的开关。
 *   需求上不存在「export 一个变量就是为了关掉它」，取或也避免了 `"0"` / 未设 / 其它值的歧义。
 *
 * @param config 录制器上携带的四个开关值；老配置或非抖音平台可能全为 `undefined`
 * @param env 便于测试注入，默认真实 `process.env`
 */
export function resolveRawLogSwitches(
  config: Partial<Record<RawLogKind, boolean>>,
  env: NodeJS.ProcessEnv = process.env,
): Record<RawLogKind, boolean> {
  return {
    pk: config.pk === true || isRawLogEnabled("pk", env),
    room: config.room === true || isRawLogEnabled("room", env),
    rank: config.rank === true || isRawLogEnabled("rank", env),
    gift: config.gift === true || isRawLogEnabled("gift", env),
  };
}

/**
 * 通用「原始报文 jsonl 转储」写入器（内部工厂）。
 *
 * 四个转储入口（pk / room / rank / gift）**共用这一份实现**；各自的包装函数只负责固定
 * 环境变量名、文件名后缀与日志标签 —— 避免「改一处漏一处」：
 * - 按输出文件隔离：目标路径变化才重新覆盖建文件
 * - 首条消息才创建文件、覆盖写（同一场录制重跑不保留旧数据）
 * - 创建失败：复位内部状态，下次可重建
 * - 追加失败：保留状态，避免下次覆盖写丢掉已落盘内容
 * - 任何失败都只告警，绝不影响录制主流程
 *
 * @param suffix 文件名后缀：`${videoPath}_${suffix}_raw.jsonl`
 * @param label 告警前缀（如 `roomRawLog`），用于从日志区分是哪一路转储
 * @param enabled 关闭时返回空操作（连文件都不创建）
 */
function createJsonlRawLogger(
  suffix: string,
  label: string,
  enabled: boolean,
): (videoPath: string | undefined, tag: string, payload: unknown) => Promise<void> {
  if (!enabled) return async () => {};

  // 开关在读**环境变量**时是静默的：没这行日志，「环境变量没传到该进程」与
  // 「传到了但这段时间一条消息都没有」两种情况在日志里都是空白，无法区分。
  console.log(`[${label}] 转储已启用（首条消息到来时才创建文件）`);

  let path: string | null = null;
  let ready: Promise<void> | null = null;

  return async (videoPath, tag, payload) => {
    if (!videoPath) return;
    const target = `${videoPath}_${suffix}_raw.jsonl`;
    const isNewTarget = path !== target;
    try {
      if (isNewTarget) {
        path = target;
        // 覆盖写：同一场录制若重跑，不保留上次的旧数据
        ready = fs.promises.writeFile(target, "", "utf-8");
      }
      await ready;
      // 只在**创建成功**后才报「已启用」：光看开关状态没意义，用户要的是
      // 「到底写没写、写到哪」——没有这行时，未启用与「启用了但一条消息都没来」
      // 在日志里完全无法区分（排查时只能靠猜环境变量）。
      if (isNewTarget) console.log(`[${label}] 转储已启用 → ${target}`);
    } catch (err) {
      // 创建失败：复位状态，允许下次重建
      path = null;
      ready = null;
      console.warn(`[${label}] 创建失败: ${(err as Error)?.message ?? err}`);
      return;
    }
    try {
      const line = JSON.stringify({ tag, at: Date.now(), payload }, longSafeReplacer) + "\n";
      await fs.promises.appendFile(target, line, "utf-8");
    } catch (err) {
      console.warn(`[${label}] 写入失败: ${(err as Error)?.message ?? err}`);
    }
  };
}

/**
 * 创建「PK 原始消息落盘」写入器（调试用）。
 *
 * 抖音的 PK 消息里 userScores 不含昵称，昵称要靠 linkMicBattle /
 * linkMicBattleFinish 的 userInfos 补齐，而这两者的到达时机并不保证。
 * 出问题时（例如某 uid 全程显示为 uid）需要原始报文才能定位，故按行写出 JSONL：
 * 一行一条消息，便于 grep / jq 处理。
 *
 * 命名沿用 XML 的规则（`streamManager.ts:295` 用 `${recordSavePath}`）：
 *   `${视频文件名}_pk_raw.jsonl`
 *
 * ⚠️ 由**每个录制会话**调用一次（见 `checkLiveStatusAndRecord`），状态随实例创建。
 * 早期实现把「文件路径 / 就绪 Promise」放在模块顶层，导致同进程内**第 2 次录制**、
 * 或**另一个房间**的录制器，都会把日志写进**第 1 次录制**的文件（跨会话串台）。
 * 现按「输出文件」而非「进程」隔离 —— 每个会话一个写入器，各自的文件互不影响。
 *
 * - 首条消息才创建文件（没有 PK 不产生空文件），创建时**覆盖写**（重跑不留旧数据）
 * - 目标文件变化（同一写入器被复用于新路径）时同样重新覆盖写
 * - 创建失败：复位内部状态，下次可重建（否则本会话原始日志永久失效）
 * - 追加失败：保留状态，避免下次覆盖写丢掉已落盘内容
 * - 任何失败都只告警，绝不影响录制主流程
 *
 * @param enabled 是否启用。默认读环境变量 `BILILIVE_TOOLS_PK_RAW_LOG`（值为 `"1"` 时开启）——
 *   **默认关闭**：每次录制都会在视频目录留下一个约 160 KB 的 `_pk_raw.jsonl`，属排查用的
 *   临时产物，不该默认产生。关闭时返回空操作（连文件都不创建）。
 */
export function createPkRawLogger(
  enabled: boolean = isRawLogEnabled("pk"),
): (videoPath: string | undefined, tag: string, payload: unknown) => Promise<void> {
  return createJsonlRawLogger("pk", "pkRawLog", enabled);
}

/**
 * 直播间人数消息原始报文转储（调试用）。
 *
 * 目的：确认 `RoomUserSeqMessage` / `RoomStatsMessage` 里哪个字段反映真实在线人数 ——
 * `seq` 的 `total` 是滞后快照、`onlineUserForAnchor` 是主播端口径的格式化文本，
 * 只有 `stats` 的 `displayValue` 是精确值（与 `total` 恒等）。排查时要看原始报文。
 *
 * 命名与 PK 转储一致：`${视频文件名}_room_raw.jsonl`，一行一条，便于 grep / jq。
 * 其余行为同 `createPkRawLogger`：按输出文件隔离、首条消息才创建、覆盖写、失败只告警。
 *
 * @param enabled 是否启用。默认读环境变量 `BILILIVE_TOOLS_ROOM_RAW_LOG`（值为 `"1"` 时开启）——
 *   **默认关闭**：`roomStats` 约 0.6 秒一条（折算约 5700 条/小时），属排查用的临时产物，
 *   不该默认产生。关闭时返回空操作（连文件都不创建）。
 */
export function createRoomRawLogger(
  enabled: boolean = isRawLogEnabled("room"),
): (videoPath: string | undefined, tag: string, payload: unknown) => Promise<void> {
  return createJsonlRawLogger("room", "roomRawLog", enabled);
}

/**
 * 贡献榜消息原始报文转储（调试用）。
 *
 * 目的：`WebcastRoomRankMessage` 是贡献榜的唯一推送通道（实测约 2 秒一条）。
 * 2026-10-25 wire 级实测（68 + 32 条快照，两个在播房间）结论：
 * - `ranks`（proto 字段 2）**恒为 3 条**，每条只有 `user`；
 *   `score_str(2)` / `profile_hidden(3)` 服务端**一个字节都没下发**
 *   （wire 里条目内只有字段 1 ⇒ 不是 wiretype 声明错，是字段缺失）
 * - 下标 +1 == 名次：与未声明字段 3 里的显式 `rank`（1..9）逐一对应
 * - 消息里还有**未声明的字段 3**：贡献榜前 9 名（`user` + 显式 `rank`），当前被 pbjs 丢弃
 * ⇒ 这条消息给不出贡献值，只能给「名次 + 用户」。
 *
 * ⚠️ 本转储写的是 `toJSON()` 结果，**看不到未声明字段**；要做 wire 级取证需 hook `decode`。
 *
 * 命名：`${视频文件名}_rank_raw.jsonl`，一行一条，便于 grep / jq。
 * 其余行为见 `createJsonlRawLogger`。
 *
 * @param enabled 是否启用。默认读环境变量 `BILILIVE_TOOLS_RANK_RAW_LOG`（值为 `"1"` 时开启）——
 *   **默认关闭**：约 2 秒一条（折算约 1800 条/小时），属排查用的临时产物，
 *   不该默认产生。关闭时返回空操作（连文件都不创建）。
 */
export function createRankRawLogger(
  enabled: boolean = isRawLogEnabled("rank"),
): (videoPath: string | undefined, tag: string, payload: unknown) => Promise<void> {
  return createJsonlRawLogger("rank", "rankRawLog", enabled);
}

/**
 * 礼物原始消息转储（调试用）。
 *
 * 目的：确认 `GiftStruct.image` / `icon` 是否下发、里面有哪些字段有值。
 * 注意 `dy.proto` 的 `Image.urlListList = 1` 目前是注释状态，运行时**拿不到 URL 列表**，
 * 只能看 `uri` / `openWebUrl` / `height` / `width` 这些字段。
 *
 * 与 PK 转储相互独立：独立实例、独立文件名（`_gift_raw.jsonl`），互不影响。
 * 其余行为（按输出文件隔离、覆盖写、失败只告警）与 `createPkRawLogger` 一致，详见其文档。
 *
 * @param enabled 是否启用。默认读环境变量 `BILILIVE_TOOLS_GIFT_RAW_LOG`（值为 `"1"` 时开启）——
 *   **默认关闭**：礼物通常是全场条数最多的消息，且单行约 2 KB（实测 71 条 = 150 KB、
 *   1017 条 = 2.0 MB），远大于 PK 转储（约 160 KB），属排查用的临时产物，不该默认产生。
 *   关闭时返回空操作（连文件都不创建）。
 */
export function createGiftRawLogger(
  enabled: boolean = isRawLogEnabled("gift"),
): (videoPath: string | undefined, tag: string, payload: unknown) => Promise<void> {
  return createJsonlRawLogger("gift", "giftRawLog", enabled);
}

/**
 * JSON.stringify 的兜底 replacer：把 protobuf.js 的 Long 对象转成十进制字符串。
 *
 * 背景：抖音的19 位 ID（roomId / channelId / msgId / userId）超过
 * Number.MAX_SAFE_INTEGER，一旦在序列化前退化成 number，低位就被抹零
 * （实测roomId 7694659564742265636 -> 7694659564742266000）。
 *
 * 解码侧已用 `toObject(decode(...), { longs: String })`，正常路径不该出现 Long；
 * 但 protobuf.js 在未显式指定 longs 时会退化为 Long 对象或 number，
 * 且各调用点的 options 可能不一致。这里做一层与语言无关的兜底，
 * 语义对齐 Go 版 protojson 的规范（uint64 输出为字符串）。
 */
export function longSafeReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    const v = value as { low?: unknown; high?: unknown; unsigned?: unknown };
    // protobuf.js 的 Long 实例形如 { low, high, unsigned }，
    // 额外要求带 unsigned 标记，避免误伤恰好含 low/high 的普通业务对象。
    if (typeof v.low === "number" && typeof v.high === "number" && "unsigned" in v) {
      const high = BigInt(v.high >>> 0);
      const low = BigInt(v.low >>> 0);
      const mod = 0x10000000000000000n; // 2^64
      const magnitude = high * 0x100000000n + low;
      // int64 的补码高位为 1 时表示负数，还原成有符号十进制
      if (v.unsigned === false && magnitude >= 0x8000000000000000n) {
        return (magnitude - mod).toString();
      }
      return magnitude.toString();
    }
  }
  return value;
}

/**
 * 写入昵称缓存。source 优先级更高的一方才允许覆盖，避免:
 * 1) battle 已写入权威昵称，却被稍后返回的 api 结果覆盖；
 * 2) api 结果先写入，随后 battle 覆盖时丢失 api 已查到的值（battle 昵称为空时）。
 *
 * 注意：**同来源**重复写入视为更新（后者覆盖前者），并非"首次为准"。
 *
 * 淘汰策略：`store.cache` 按 **LRU（最近使用）** 淘汰 —— 写入或命中都会把条目挪到
 * Map 末尾（`Map.set` 不改变已有键顺序，故「先删再插」，见下与 `touchPkCacheEntry`），
 * 满 `PK_NICKNAME_CACHE_LIMIT` 时淘汰最前（最久未用）的一条。
 * `updatedAt` 仅作诊断，不参与淘汰决策。
 *
 * @returns 是否**实际写入**。被更高优先级挡下时为 `false`。
 *   这个返回值是承重的 —— 缓存与映射表是两份独立状态，调用方必须据此决定
 *   要不要 `registerPkNickname`，否则会出现「缓存里是 battle 权威昵称、
 *   映射表却被迟到的 api 结果覆盖」的不一致。
 */
export function writePkNickname(
  store: PkNicknameStore,
  uid: string,
  nickname: string,
  source: PkNicknameSource,
): boolean {
  if (!uid || !nickname) return false;
  const existing = store.cache.get(uid);
  if (existing && PK_NICKNAME_PRIORITY[existing.source] > PK_NICKNAME_PRIORITY[source]) {
    return false;
  }
  // 容量保护：仅当**新键**且已满时，淘汰「最久未使用」的一条（Map 首项 = 最久未用）
  if (!store.cache.has(uid) && store.cache.size >= PK_NICKNAME_CACHE_LIMIT) {
    const oldest = store.cache.keys().next();
    if (!oldest.done) store.cache.delete(oldest.value);
  }
  // 写入 = 最近使用：先删再插，把该键挪到 Map 末尾（否则覆盖不改变原有顺序）
  if (store.cache.has(uid)) store.cache.delete(uid);
  store.cache.set(uid, { nickname, source, updatedAt: Date.now() });
  store.failed.delete(uid);
  return true;
}

/**
 * 把缓存条目标记为「最近使用」（挪到 Map 末尾），供**只读命中**的路径调用 ——
 * 使 `store.cache` 的淘汰顺序真正反映"最近使用"而不是"最早插入"。
 */
function touchPkCacheEntry(store: PkNicknameStore, uid: string): void {
  const entry = store.cache.get(uid);
  if (!entry) return;
  store.cache.delete(uid);
  store.cache.set(uid, entry);
}

/** 上限保护：超出后淘汰最旧的一条，防止长期进程无界增长（与 store.cache 的上限对称，D3） */
function capSet(set: Set<string>, limit: number): void {
  if (set.size > limit) {
    const it = set.values().next();
    if (!it.done) set.delete(it.value);
  }
}

/**
 * 把 uid 标记为「本会话不再查询」并只告警一次。
 *
 * `not_found`（服务端确认不存在）与 `unavailable`（本次未取到）都用它 ——
 * **后果一致**（都不再查，避免持续故障下反复打接口触发风控），只有告警措辞区分原因。
 */
function markPkNicknameSkipped(store: PkNicknameStore, uid: string, reason: string): void {
  store.failed.add(uid);
  capSet(store.failed, PK_NICKNAME_FAILED_LIMIT);
  if (store.warnedFailed.has(uid)) return;
  store.warnedFailed.add(uid);
  capSet(store.warnedFailed, PK_NICKNAME_WARNED_LIMIT);
  console.warn(`[PK] uid ${uid} ${reason}`);
}

/**
 * 把昵称查询结果路由到对应缓存：
 * - found        → onFound（写成功缓存 + 登记映射表）
 * - not_found    → onNotFound（服务端确认该 uid 不存在）
 * - unavailable  → onUnavailable（本次未取到：ttwid / 网络 / HTTP / 响应体异常）
 *
 * ⚠️ 两者**后果相同、含义不同**：调用方都记入「不再查」，但日志必须区分 ——
 * `not_found` 是结论（重启也没用），`unavailable` 只是这一次没拿到（重启可重查）。
 *
 * 抽成纯函数以便单测 + 变异验证。
 */
export function routePkNicknameResult(
  result: GetUserNicknameResult,
  handlers: {
    onFound: (nickname: string) => void;
    onNotFound: () => void;
    onUnavailable: () => void;
  },
): void {
  if (result.status === "found") {
    handlers.onFound(result.nickname);
  } else if (result.status === "not_found") {
    handlers.onNotFound();
  } else {
    handlers.onUnavailable();
  }
}

/**
 * `flush` 前批量补齐昵称：对「尚无昵称」的 uid 先复用已有结果，再按并发补查。
 *
 * 为什么需要：
 * 1) 录制期间**不再即时查询**（分数消息只登记 uid），查询集中到这里 —— 有 battle 的
 *    场次因此完全不发请求；
 * 2) 查询发生在 `flush()` 取映射表快照**之前**，根除「结果在落盘后才回来、
 *    被 `hasCompleted` 丢弃」的竞态（已用一次性脚本实测复现）。
 *
 * @param store 该场次的昵称状态（见 `PkNicknameStore`）
 * @param uids controller 侧「本场出现过、且尚无昵称」的 uid
 * @param opts.timeoutMs 整批的总超时（默认 `PK_NICKNAME_FLUSH_WAIT_TIMEOUT`）
 * @param opts.concurrency 并发上限（默认 `PK_NICKNAME_FLUSH_CONCURRENCY`）
 * @param opts.query 查询函数（默认 `getUserNickname`；仅为可测试而可注入）
 * @param opts.inflight 需先等待收尾的在途查询（默认取 `store.pending`；仅为可测试而可注入）
 * @returns uid -> 昵称（仅包含确实拿到的）
 */
export async function resolvePendingPkNicknames(
  store: PkNicknameStore,
  uids: string[],
  opts: {
    timeoutMs?: number;
    concurrency?: number;
    query?: (uid: string) => Promise<GetUserNicknameResult>;
    inflight?: Promise<unknown>[];
  } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (uids.length === 0) return out;

  const timeoutMs = opts.timeoutMs ?? PK_NICKNAME_FLUSH_WAIT_TIMEOUT;
  const concurrency = opts.concurrency ?? PK_NICKNAME_FLUSH_CONCURRENCY;
  const query = opts.query ?? getUserNickname;

  // 1) 已有结果的直接用：缓存命中取之；本会话不再查询的 uid 跳过
  const todo: string[] = [];
  for (const uid of uids) {
    const hit = store.cache.get(uid);
    if (hit?.nickname) {
      out.set(uid, hit.nickname);
      touchPkCacheEntry(store, uid); // 命中即「最近使用」，避免热点条目被先淘汰
      continue;
    }
    if (store.failed.has(uid)) continue;
    todo.push(uid);
  }
  if (todo.length === 0) return out;

  // 2) 在「总超时」内完成：先等在途查询收尾，再按并发补查
  //    deadline 持有定时器句柄，race 结束后**必须清掉** —— 否则正常的快速路径
  //    仍会留下一个最长 timeoutMs 的定时器（虽已 unref、不阻塞事件循环，但白占资源）。
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, timeoutMs);
    deadlineTimer.unref?.();
  });
  const work = (async () => {
    const inflight = opts.inflight ?? [...store.pending.values()];
    if (inflight.length > 0) await Promise.allSettled(inflight);

    for (let i = 0; i < todo.length; i += concurrency) {
      const chunk = todo.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (uid) => {
          if (store.cache.has(uid) || store.failed.has(uid)) return;
          let pending = store.pending.get(uid);
          if (!pending) {
            pending = query(uid)
              .catch(() => null)
              .finally(() => store.pending.delete(uid));
            store.pending.set(uid, pending);
          }
          const result = await pending;
          routePkNicknameResult(result ?? { status: "unavailable" }, {
            onFound: (nickname) => {
              writePkNickname(store, uid, nickname, "api");
            },
            onNotFound: () => {
              markPkNicknameSkipped(
                store,
                uid,
                "查不到昵称（服务端确认不存在，本会话不再查）。" +
                  "该 uid 可能是抖音内部 ID 而非抖音号，无法通过昵称接口查询。",
              );
            },
            onUnavailable: () => {
              markPkNicknameSkipped(
                store,
                uid,
                "本次未取到昵称（原因见上一条日志），本会话不再查询；需要重查请重启程序。",
              );
            },
          });
        }),
      );
    }
  })();
  try {
    await Promise.race([work, deadline]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  // 3) 回读（即使超时，也把已拿到的带回）
  for (const uid of todo) {
    const hit = store.cache.get(uid);
    if (hit?.nickname) out.set(uid, hit.nickname);
  }
  return out;
}

/**
 * 对 PK 选手做确定性排序，供产出 pk_score 消息时使用。
 *
 * 背景：抖音推送的 `userScores` 顺序在同一场 PK 内是**逐帧轮转**的（像环形缓冲的
 * 读偏移在变，实测 497/497 段都满足"同一循环序列的旋转"）。若原样平铺，XSL 表格的
 * 选手行序会每秒乱跳、作为时间序列基本不可读。这里在产出消息时一次性归一化。
 *
 * 排序键（已用真实样本核实），优先级从高到低：
 * 1) `teamRank` 升序（团队排名）—— 团队 PK 时把同一团队的选手聚在一起；
 *    非团队 PK 时 teamRank 全为空，所有选手落入同一组，自然回落到第 2 键。
 * 2) `battleRank` 升序（个人名次，`rank` 与个人分数单调对应：rank 相同 ⇒ 分数并列；
 *    分数相同时服务端按团队表现做 tiebreak，rank 仍唯一确定）。
 * 3) 兜底 `uid` 升序：rank 重复（如多人并列垫底）时保证稳定、可复现的次序。
 *
 * 仅做展示层归一化，不改任何语义；缺字段（理论不会发生）视为垫底。
 */
export function sortPkPlayers<T extends { uid: string; rank?: string; teamRank?: string }>(
  players: T[],
): T[] {
  return [...players].sort((a, b) => {
    // 1) 团队排名升序；无团队（teamRank 为空）视为同一组，跳到第 2 键
    const tra = a.teamRank === undefined || a.teamRank === "" ? Infinity : Number(a.teamRank);
    const trb = b.teamRank === undefined || b.teamRank === "" ? Infinity : Number(b.teamRank);
    if (tra !== trb) return tra - trb;
    // 2) 个人名次升序
    const ra = a.rank === undefined || a.rank === "" ? Infinity : Number(a.rank);
    const rb = b.rank === undefined || b.rank === "" ? Infinity : Number(b.rank);
    if (ra !== rb) return ra - rb;
    // 3) uid 兜底
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
}

/**
 * 从 `WebcastRoomStatsMessage` 构造 `room_stats` 消息（纯函数，便于单测）。
 *
 * **取值口径只认 `displayValue`**：实测它与 `total` 恒等，是唯一精确的在线人数。
 * 不用 `RoomUserSeqMessage` —— 其 `total` 是滞后快照（同刻差 +219~-488 且随人数上升单调变负），
 * `onlineUserForAnchor` 是主播端口径的格式化文本（「1.3万」），都无法落到数值字段。
 *
 * 抽成纯函数的原因：`save` 开关原先埋在事件回调里，无法被测试覆盖。
 * 与 `buildPkScoreMessage` 同一约定：不可用时返回 `null`，由调用方丢弃。
 *
 * @param options.save 用户是否开启「在线人数」开关；`false` 时返回 `null`
 * @returns room_stats 消息；开关关闭或取不到人数时返回 `null`
 */
export function buildRoomStatsMessage(
  msg: {
    displayValue?: string | number;
    common?: { createTime?: string | number };
  },
  options: { useServerTimestamp: boolean; save?: boolean; now?: number },
): Message | null {
  const { useServerTimestamp, save = true } = options;
  if (!save) return null;

  const online = String(msg.displayValue ?? "");
  if (!online) return null;

  return {
    type: "room_stats",
    // createTime 有秒/毫秒两种口径（实测两种都出现过），单位交给 resolveTimestamp 统一判别；
    // 缺失 / "0" 时回落到 now，不再产出 timestamp=0（会静默排到时间线最前）
    timestamp: resolveTimestamp(msg.common?.createTime, {
      useServerTimestamp,
      unit: "ms",
      now: options.now,
    }),
    online,
  };
}

/**
 * 从 `WebcastRoomRankMessage` 构造 `room_rank` 消息（纯函数，便于单测）。
 *
 * **数组顺序即名次**：`ranks[0]` 就是第 1 名，消息上不再另带 rank。依据是未声明字段 3 里的显式
 * `rank` 实测为 1..9 递增、且前 3 名的 uid 与 `ranks` 逐一相等 —— 服务端已按名次排好。
 *
 * 只取 `user.id` / `user.nickName` / `user.AvatarThumb.uri` 三项。**不要 `scoreStr`**：proto 里虽然
 * 声明了 `score_str`(2) 与 `profile_hidden`(3)，但实测 204/204 条目都没下发过，wire 上也找不到
 * `/2/bytes/2`、`/2/bytes/3` 这两条路径 ⇒ 贡献值这条路目前是死的，别在类型上假装有。
 *
 * @param options.useServerTimestamp 是否用服务端 createTime 作时间戳（与 `room_stats` 同一口径）
 * @param options.save 用户是否开启「贡献榜」开关；`false` 时返回 `null`
 * @returns room_rank 消息；开关关闭时返回 `null`；`ranks` 缺失/为空/全部缺 uid 时也返回 `null`
 */
export function buildRoomRankMessage(
  msg: {
    ranks?: {
      user?: {
        id?: string;
        nickName?: string;
        /** ⚠️ 首字母大写：proto 里字段名就是 `AvatarThumb`，与 `PkScore` 的小写下划线风格不同 */
        AvatarThumb?: { uri?: string } | null;
      } | null;
    }[];
    common?: { createTime?: string | number };
  },
  options: { useServerTimestamp: boolean; save?: boolean; now?: number },
): Message | null {
  const { useServerTimestamp, save = true } = options;
  if (!save) return null;

  const users: { uid: string; nick: string; avatarUri?: string }[] = [];
  for (const item of msg.ranks ?? []) {
    const user = item?.user;
    const uid = String(user?.id ?? "");
    // 缺 uid 的条目整条丢弃：uid 是 `<u>` 的唯一标识，缺了就无从关联
    // （`<rank_users>` 的键是 `(uid, 昵称)`，见 liveManager 的 `avatarKey`）。
    if (!uid) continue;
    const avatarUri = user?.AvatarThumb?.uri;
    users.push({
      uid,
      nick: String(user?.nickName ?? ""),
      ...(avatarUri ? { avatarUri } : {}),
    });
  }
  // 空榜不生成消息：写了会让 XSL 多出一个空表，且与「本场没有榜」无法区分。
  if (users.length === 0) return null;

  return {
    type: "room_rank",
    // createTime 实测有秒/毫秒两种口径，单位交给 resolveTimestamp 统一判别；
    // 缺失 / "0" 时回落到 now，不再产出 timestamp=0（会静默排到时间线最前）
    timestamp: resolveTimestamp(msg.common?.createTime, {
      useServerTimestamp,
      unit: "ms",
      now: options.now,
    }),
    users,
  };
}

/**
 * 从 `WebcastLinkMicMethod` 消息构造 `pk_score` 消息（纯函数，便于单测）。
 *
 * **为什么需要抽出来**：`msg.userScores` 在 proto 里是 `repeated`，抖音的
 * `WebcastLinkMicMethod` 也承载**非 PK 的普通连麦**（邀请/挂断等），这类消息
 * **不含 `user_scores`**。此时 protobufjs 的 `toObject` 会给出 `undefined`
 * （实测：空 repeated 字段不进对象），而 `for...of undefined` 会抛
 * `TypeError: msg.userScores is not iterable`。
 *
 * 该异常会被 `DouYinDanma.decode` 的 try/catch 吞掉（只打一行 console.error），
 * 后果是**整条 PK 分数消息被丢弃**，且不会有任何显式报错。
 *
 * 因此这里对 `userScores` 做空值归一：缺失/空数组时返回 `null`，由调用方跳过。
 *
 * @returns pk_score 消息；无有效选手时返回 `null`
 */
export function buildPkScoreMessage(
  msg: {
    userScores?: {
      userId?: string;
      score?: string;
      battleRank?: string;
      multiPkTeamScore?: string;
      multiPkTeamRank?: string;
    }[];
    common?: { createTime?: string | number };
    /** 单场 PK 标识（LinkMicMethod.battle_id = 104）。一条直播可打多场 PK，靠它把快照归属到场次。 */
    battleId?: string;
  },
  useServerTimestamp: boolean,
  now: number = Date.now(),
): {
  type: "pk_score";
  timestamp: number;
  battleId?: string;
  players: { uid: string; score: string; rank: string; teamScore: string; teamRank: string }[];
} | null {
  const userScores = msg.userScores ?? [];
  if (userScores.length === 0) return null;

  // createTime 实测有秒/毫秒两种口径，单位交给 resolveTimestamp 统一判别；
  // 缺失 / "0" 时回落到 now，不再产出 timestamp=0（会静默排到时间线最前）
  const timestamp = resolveTimestamp(msg.common?.createTime, {
    useServerTimestamp,
    unit: "ms",
    now,
  });

  // 按名次确定性排序，消除抖音推送顺序逐帧轮转导致的表格行序乱跳
  const players = sortPkPlayers(
    userScores
      // 缺 userId 的项无法定位选手，直接跳过（避免写出 uid="undefined" 的脏行）
      .filter((s) => Boolean(s.userId))
      .map((s) => ({
        uid: s.userId as string,
        score: s.score ?? "0",
        rank: s.battleRank ?? "",
        teamScore: s.multiPkTeamScore ?? "",
        teamRank: s.multiPkTeamRank ?? "",
      })),
  );
  // 过滤后可能仍无有效选手（脏数据），此时不应产出空 players 的消息 ——
  // 空 players 的 <pk> 段既无意义、又会在 XSL 里渲染出空表。
  if (players.length === 0) return null;

  return {
    type: "pk_score",
    timestamp,
    // 缺省时整个键不出现（与 XML 里 team_* 的处理一致，避免写出 battle_id=""）
    ...(msg.battleId ? { battleId: msg.battleId } : {}),
    players,
  };
}

/**
 * 按「保存礼物图片 / 保存送礼用户头像」两个开关，决定礼物消息上是否带这两项资源路径。
 *
 * 关掉时**不采集**（而不是写进 XML 再过滤）：两者只被 XML 生成端消费，不采集即
 * `<gi>` 表不出现、`gift` 上没有 `a`，预览表格对应列留空（XSL 两列都有 `z:if` 守卫，
 * 不会输出空 src）。
 *
 * 判据用 `!== false` 而不是 `=== true`：老配置里没有这两个键，undefined 必须保持原有行为。
 * 抽成纯函数是为了可单测 —— 调用点在 `client.on("gift")` 回调里，无法直接覆盖。
 *
 * @param imageUri 礼物图标相对路径（`msg.gift.image?.uri`）
 * @param avatarUri 送礼者头像相对路径（`msg.user.AvatarThumb?.uri`）
 */
export function pickGiftAssets(
  imageUri: string | undefined,
  avatarUri: string | undefined,
  options: { saveIcon?: boolean; saveAvatar?: boolean },
): { imageUri?: string; avatar?: string } {
  return {
    ...(options.saveIcon !== false && imageUri ? { imageUri } : {}),
    ...(options.saveAvatar !== false && avatarUri ? { avatar: avatarUri } : {}),
  };
}

const checkLiveStatusAndRecord: Recorder["checkLiveStatusAndRecord"] = async function ({
  getSavePath,
  banLiveId,
  isManualStart,
  streamRetryHint,
}) {
  // 如果已经在录制中,只在需要检查标题关键词时才获取最新信息
  if (this.recordHandle != null) {
    const shouldStop = await utils.checkTitleKeywordsWhileRecording(
      this,
      isManualStart,
      (channelId) =>
        getInfo(channelId, {
          auth: this.auth,
          api: this.api as APIType,
          uid: this.uid,
        }),
    );
    if (shouldStop) {
      return null;
    }

    // 已经在录制中，直接返回
    return this.recordHandle;
  }

  // 获取直播间信息
  let isLiveRadio = false;
  try {
    const liveInfo = await getInfo(this.channelId, {
      auth: this.auth,
      api: this.api as APIType,
      uid: this.uid,
    });
    this.liveInfo = liveInfo;
    isLiveRadio = liveInfo.isLiveRadio;
    this.emit("stateChange", { state: "idle" });
  } catch (error) {
    this.emit("stateChange", {
      state: "check-error",
      msg: `检查失败，` + (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }

  if (this.liveInfo.liveId && this.liveInfo.liveId === banLiveId) {
    this.tempStopIntervalCheck = true;
  } else {
    this.tempStopIntervalCheck = false;
  }
  if (this.tempStopIntervalCheck) return null;
  if (!this.liveInfo.living) return null;

  // 检查标题是否包含关键词
  if (utils.checkTitleKeywordsBeforeRecord(this.liveInfo.title, this, isManualStart)) return null;

  const qualityRetryLeft = (await this.cache.get("qualityRetryLeft")) ?? this.qualityRetry;
  const strictQuality = utils.shouldUseStrictQuality(
    qualityRetryLeft,
    this.qualityRetry,
    isManualStart,
  );

  let res: Awaited<ReturnType<typeof getStream>>;
  try {
    res = await getStream({
      channelId: this.channelId,
      quality: this.quality,
      streamPriorities: this.streamPriorities,
      sourcePriorities: this.sourcePriorities,
      strictQuality: strictQuality,
      auth: this.auth,
      formatPriorities: this.formatPriorities,
      doubleScreen: this.doubleScreen,
      api: this.api as APIType,
      uid: this.uid,
      isLiveRadio: isLiveRadio,
      preferAlternativeStream:
        streamRetryHint?.preferAlternativeStream === true &&
        streamRetryHint.liveId === this.liveInfo.liveId,
    });
    this.liveInfo.owner = res.owner;
    this.liveInfo.title = res.title;
    this.liveInfo.cover = res.cover;
    this.liveInfo.liveId = res.liveId;
    this.liveInfo.avatar = res.avatar;

    // 再检查一次，上一个接口可能不存在标题参数
    if (utils.checkTitleKeywordsBeforeRecord(this.liveInfo.title, this, isManualStart)) return null;
  } catch (err) {
    if (qualityRetryLeft > 0) await this.cache.set("qualityRetryLeft", qualityRetryLeft - 1);

    this.emit("stateChange", {
      state: "check-error",
      msg: `检查失败，` + (err instanceof Error ? err.message : String(err)),
    });
    throw err;
  }
  const { owner, title, liveStartTime, recordStartTime } = this.liveInfo;

  this.emit("stateChange", { state: "recording" });
  const { currentStream: stream, sources: availableSources, streams: availableStreams } = res;
  this.availableStreams = availableStreams.map((s) => s.desc);
  this.availableSources = availableSources.map((s) => s.name);
  this.usedStream = stream.name;
  this.usedSource = stream.source;

  let isEnded = false;
  const onEnd = (...args: unknown[]) => {
    if (isEnded) return;
    isEnded = true;
    this.emit("DebugLog", {
      type: "common",
      text: `record end, reason: ${JSON.stringify(args, (_, v) => (v instanceof Error ? v.stack : v))}`,
    });
    const reason = args[0] instanceof Error ? args[0].message : String(args[0]);
    this.recordHandle?.stop(reason);
  };

  const downloader = createDownloader(
    this.recorderType,
    {
      url: stream.url,
      outputOptions: ffmpegOutputOptions,
      inputOptions: ffmpegInputOptions,
      segment: this.segment ?? 0,
      getSavePath: (opts) =>
        getSavePath({
          owner,
          title: opts.title ?? title,
          startTime: opts.startTime,
          liveStartTime: liveStartTime,
          recordStartTime,
          extraMs: opts.extraMs,
        }),
      disableDanma: this.disableProvideCommentsWhenRecording,
      videoFormat: this.videoFormat ?? "auto",
      debugLevel: this.debugLevel ?? "none",
      onlyAudio: stream.onlyAudio,
      headers: {
        Origin: "https://live.douyin.com",
        Referer: "https://live.douyin.com/",
        // Cookie: this.auth,
      },
      proxy: this.proxy,
    },
    onEnd,
    async () => {
      const info = await getInfo(this.channelId, {
        auth: this.auth,
      });
      return info;
    },
  );

  /**
   * 本「直播场次」的 PK 昵称状态。
   *
   * 按 `${channelId}#${liveId}` 隔离：跨场次不复用（昵称会随改名过期），同场次断线
   * 重连复用（liveId 不变），多房间同时录制互不影响。详见 `PkNicknameStore`。
   */
  const pkStore = getPkNicknameStore(
    buildPkNicknameStoreKey(this.channelId, this.liveInfo?.liveId),
  );

  const handleVideoCreated = async ({ filename, title, cover, rawFilename }) => {
    this.emit("videoFileCreated", { filename, cover, rawFilename });

    if (title && this?.liveInfo) {
      this.liveInfo.title = title;
    }
    if (cover && this?.liveInfo) {
      this.liveInfo.cover = cover;
    }
    const extraDataController = downloader.getExtraDataController();
    extraDataController?.setMeta({
      room_id: this.channelId,
      platform: provider?.id,
      // liveStartTimestamp: liveInfo.startTime?.getTime(),
      // recordStopTimestamp: Date.now(),
      title: title,
      user_name: owner,
    });
    // flush 前补齐昵称：把「批量查询（含等在途 + 回读缓存）」的能力交给 controller，
    // 让它在落盘映射表之前调用 —— 既消除录制期的白查，也保证查询早于快照（修竞态）。
    // 每次 videoFileCreated（含分段录制的每一段）都会走到这里，因此每个 controller 实例都会被注入。
    extraDataController?.setNicknameProvider((uids) => resolvePendingPkNicknames(pkStore, uids));
  };
  downloader.on("videoFileCreated", handleVideoCreated);
  downloader.on("videoFileCompleted", (data) => {
    this.emit("videoFileCompleted", data);
  });
  downloader.on("DebugLog", (data) => {
    this.emit("DebugLog", data);
  });
  downloader.on("progress", (progress) => {
    if (this.recordHandle) {
      this.recordHandle.progress = progress;
    }
    this.emit("progress", progress);
  });

  // 礼物消息缓存管理
  const giftMessageCache = new Map<
    string,
    {
      gift: GiveGift;
      timer: NodeJS.Timeout;
    }
  >();

  // 录制期间**不再即时查询昵称**（批式改造）：分数消息只把 uid 交给 controller 登记，
  // 查询统一推迟到 `flush` 前由 `resolvePendingPkNicknames` 批量完成 ——
  // 这样「battle 覆盖全场」的场次完全不发请求，且查询结果必定早于映射表快照。

  // 礼物延迟处理时间(毫秒),可根据实际情况调整
  const GIFT_DELAY = 5000;

  const client = new DouYinDanmaClient(this?.liveInfo?.liveId as string, {
    cookie: this.auth,
  });

  /**
   * 昵称缓存的建立策略（同一场 PK 只建立一次，避免重复/无意义覆盖）：
   *
   *   场景 1「全程观看」：battleId 相同，开始与结束属同一场 PK
   *       => 仅用「PK 开始」写缓存；结束事件不再重复写。
   *   场景 2「中途加入且等到结束」：未收到本场开始事件，收到了结束事件
   *       => 用「PK 结束」写缓存（battle 来源，权威），不必依赖接口。
   *   场景 3「中途加入未等到结束」：两条battle 事件都没收到
   *       => 由分数消息登记 uid，flush 前批量反查接口兜底（见 `resolvePendingPkNicknames`）。
   *
   * 场次判定：`battleId` 相同即视为同一场（单场 PK 的唯一标识）。
   * 取不到 `battleId` 时**不做去重**（返回 null 直接放行）—— 重复写缓存无害，错误合并会丢昵称。
   * ⚠️ 既不用 `channelId`（只表示同一次开播，多场 PK 共用同一个值），
   * 也不用 uid 集合（连打同一批对手时集合也相同）—— 两者都有实测样本证明会误合并。
   *
   * 幂等性：
   * - 同一场次重复的 battle / battleFinish 事件只生效第一次
   *   （见 pkNicknameCache.ts 的 createPkChannelTracker）；
   * - 跨来源允许 battle 覆盖 api（api 是兜底，昵称可能已过期）；
   *   反向（api 覆盖 battle）被 `writePkNickname` 的优先级拒绝；
   * - 同来源重复写入视为更新（last-write-wins，非"首次为准"）；
   * - 只有 `writePkNickname` 实际写入成功时才登记映射表，保证缓存与映射表一致。
   */
  const warmPkNicknamesFromUserInfos = (
    userInfos: Record<string, { user?: { userId?: string; nickName?: string } }> | undefined,
  ) => {
    const ctrl = downloader.getExtraDataController();
    for (const { uid, nickname } of collectPkNicknames(userInfos)) {
      // battle 是最高优先级，正常情况下必然写入成功；仍判断返回值，
      // 是为了让「缓存与映射表必须一致」这条不变量在所有来源上都成立。
      if (!writePkNickname(pkStore, uid, nickname, "battle")) continue;
      // 登记到 XML 末尾的映射表（昵称的唯一权威来源）
      ctrl?.registerPkNickname(uid, nickname);
    }
  };

  /** 场次去重：同一场 PK 只让首个事件生效（实现见 pkNicknameCache.ts） */
  const pkChannelTracker = createPkChannelTracker();

  // 四路转储的开关只读一次，同时用于「写入器」与「全关汇总日志」：分两处各读一次，
  // 会出现「日志说没开、实际却在写文件」这种自相矛盾的排查现场。
  const rawLogSwitches = resolveRawLogSwitches({
    pk: this.rawLogPk,
    room: this.rawLogRoom,
    rank: this.rawLogRank,
    gift: this.rawLogGift,
  });
  const disabledRawLogHint = describeDisabledRawLogs(rawLogSwitches);
  if (disabledRawLogHint) console.log(disabledRawLogHint);

  // PK 原始日志写入器：**每个录制会话一个实例**，状态随会话创建、不跨会话复用。
  // 早期实现是模块级单例，导致第 2 次录制/另一房间写进第 1 次录制的文件（跨会话串台）。
  const appendPkRawLog = createPkRawLogger(rawLogSwitches.pk);
  // 人数消息转储：默认关闭，设 BILILIVE_TOOLS_ROOM_RAW_LOG=1 才写 _room_raw.jsonl
  const appendRoomRawLog = createRoomRawLogger(rawLogSwitches.room);
  // 贡献榜消息转储：默认关闭，设 BILILIVE_TOOLS_RANK_RAW_LOG=1 才写 _rank_raw.jsonl
  const appendRankRawLog = createRankRawLogger(rawLogSwitches.rank);
  // 礼物原始消息转储（临时调试，与 PK 转储独立）：确认 gift.image 下发了哪些字段。
  const appendGiftRawLog = createGiftRawLogger(rawLogSwitches.gift);

  client.on("linkMicBattle", (msg) => {
    // user_infos 是 map<int64,...>，protobufjs 把 int64 键转成不可读哈希串；
    // 重排成真实 uid 键，消除 _pk_raw.jsonl 调试转储里的乱码（下游只读 values，不受影响）。
    msg.userInfos = normalizeUserInfosKeys(msg.userInfos);
    void appendPkRawLog(downloader.videoFilePath, "linkMicBattle", msg);
    // 场景 1：同一场次若已由「结束事件」处理过，则不再用开始事件覆盖
    // （中途接入时结束事件先到的情况极少见，但需保证幂等）
    const key = buildBattleKey(msg.battleSettings);
    if (pkChannelTracker.acceptBattle(key)) {
      // 关闭 PK 时不能登记昵称：registerPkNickname 会直接写 XML 末尾的 <pk_users> 映射表
      if (this.savePk !== false) warmPkNicknamesFromUserInfos(msg.userInfos);
    }
  });

  /**
   * PK 结束消息。
   *
   * - 场景 1（本场已由开始事件建过缓存）=> 直接跳过，不重复写入；
   * - 场景 2（中途接入，未收到本场开始事件）=> 用结束事件建立缓存，不调用接口；
   * - 重复的结束事件做幂等处理：同一场次只生效一次。
   */
  client.on("linkMicBattleFinish", (msg) => {
    // 同上：user_infos 键归一化为真实 uid，消除调试转储里的乱码。
    msg.userInfos = normalizeUserInfosKeys(msg.userInfos);
    void appendPkRawLog(downloader.videoFilePath, "linkMicBattleFinish", msg);
    // 场景 1（本场已由开始事件建过缓存）或重复的结束事件 => 跳过，不重复写入
    const key = buildBattleKey(msg.battleSettings);
    if (pkChannelTracker.acceptBattleFinish(key)) {
      // 同 linkMicBattle：关闭 PK 时不写昵称映射表
      if (this.savePk !== false) warmPkNicknamesFromUserInfos(msg.userInfos);
    }
  });

  // 人数相关消息（转储开关见 createRoomRawLogger）。两者原样落盘，便于比对字段口径。
  client.on("roomUserSeq", (msg) => {
    void appendRoomRawLog(downloader.videoFilePath, "roomUserSeq", msg);
  });
  client.on("roomStats", (msg) => {
    void appendRoomRawLog(downloader.videoFilePath, "roomStats", msg);
    const extraDataController = downloader.getExtraDataController();
    if (!extraDataController) return;
    const roomStatsMessage = buildRoomStatsMessage(msg, {
      // `useServerTimestamp` 在 Recorder 类型里可选，但 `createRecorder` 已把它兜底成 boolean
      // （`opts.useServerTimestamp ?? true`），所以这里的默认值**实际不可达**。
      // 仍写 `true` 是为了与上游 `createRecorder`、以及 PK 那处保持一致 —— 万一将来兜底被去掉，
      // 也不会让 room/rank 静默退回本地时间。
      useServerTimestamp: this.useServerTimestamp ?? true,
      save: this.saveRoomStats !== false,
    });
    if (!roomStatsMessage) return;
    extraDataController.addMessage(roomStatsMessage);
  });

  // 贡献榜消息（转储开关见 createRankRawLogger）。
  client.on("roomRank", (msg) => {
    void appendRankRawLog(downloader.videoFilePath, "roomRank", msg);
    const extraDataController = downloader.getExtraDataController();
    if (!extraDataController) return;
    const roomRankMessage = buildRoomRankMessage(msg, {
      // 同上：默认值统一为 `true`（与 roomStats / PK / 上游一致），实际不可达
      useServerTimestamp: this.useServerTimestamp ?? true,
      save: this.saveRoomRank !== false,
    });
    if (!roomRankMessage) return;
    extraDataController.addMessage(roomRankMessage);
  });

  client.on("chat", (msg) => {
    const extraDataController = downloader.getExtraDataController();
    if (!extraDataController) return;
    let timestamp: number = Date.now();
    if (this.useServerTimestamp && msg.eventTime) {
      // 某些消息可能没有 eventTime 字段
      timestamp = Number(msg.eventTime) * 1000;
    }
    const comment: Comment = {
      type: "comment",
      timestamp: timestamp,
      text: msg.content,
      color: "#ffffff",
      sender: {
        uid: msg.user.id,
        name: msg.user.nickName,
        extra: {
          level: msg.user.PayGrade?.level ?? "0",
          clubLevel: msg.user.FansClub?.data?.level ?? "0",
        },
      },
    };
    this.emit("Message", comment);
    extraDataController.addMessage(comment);
  });
  client.on("privilegeScreenChat", (msg) => {
    const extraDataController = downloader.getExtraDataController();
    if (!extraDataController) return;
    const comment: Comment = {
      type: "comment",
      // 抖音飘屏没有时间戳数据，默认使用当前时间
      timestamp: Date.now(),
      text: msg.content,
      color: "#e0c39c",
      sender: {
        uid: msg.user.id,
        name: msg.user.nickName,
        extra: {
          level: msg.user.PayGrade?.level ?? "0",
          clubLevel: msg.user.FansClub?.data?.level ?? "0",
        },
      },
    };
    this.emit("Message", comment);
    extraDataController.addMessage(comment);
  });
  client.on("screenChat", (msg) => {
    const extraDataController = downloader.getExtraDataController();
    if (!extraDataController) return;
    const comment: Comment = {
      type: "comment",
      timestamp: this.useServerTimestamp ? Number(msg.eventTime) / 1000000 : Date.now(),
      text: msg.content,
      color: "#d7f6fc",
      sender: {
        uid: msg.user.id,
        name: msg.user.nickName,
        extra: {
          level: msg.user.PayGrade?.level ?? "0",
          clubLevel: msg.user.FansClub?.data?.level ?? "0",
        },
      },
    };
    this.emit("Message", comment);
    extraDataController.addMessage(comment);
  });
  client.on("gift", (msg) => {
    // 先落盘原始消息：刻意放在礼物开关判断**之前**，这样关闭「保存礼物」时
    // 仍能拿到原始报文排查图片字段（转储默认关闭，见 `createGiftRawLogger`）
    void appendGiftRawLog(downloader.videoFilePath, "gift", msg);
    const extraDataController = downloader.getExtraDataController();
    if (!extraDataController) return;
    if (this.saveGiftDanma === false) return;

    const serverTimestamp =
      Number(msg.common.createTime) > 9999999999
        ? Number(msg.common.createTime)
        : Number(msg.common.createTime) * 1000;

    // 图片与头像各受一个开关控制，关掉的那项直接不采集（见 pickGiftAssets）
    const { imageUri, avatar } = pickGiftAssets(msg.gift.image?.uri, msg.user.AvatarThumb?.uri, {
      saveIcon: this.saveGiftIcon,
      saveAvatar: this.saveGiftAvatar,
    });

    const gift: GiveGift = {
      type: "give_gift",
      timestamp: this.useServerTimestamp ? serverTimestamp : Date.now(),
      name: msg.gift.name,
      price: msg.gift.diamondCount / 10 || 0,
      count: Number(msg.totalCount ?? 1),
      color: "#ffffff",
      // 只存相对路径（webcast/xxx.png）：CDN 域名与模板参数由消费方拼接，避免域名轮换后数据失效
      ...(imageUri ? { imageUri } : {}),
      // 用 String()：proto 里 giftId 是 uint64，运行时是 Long 对象，不能直接当 number 用
      giftId: String(msg.giftId ?? ""),
      sender: {
        uid: msg.user.id,
        name: msg?.user?.nickName || "unknown",
        // 头像相对路径（100x100/aweme-avatar/xxx，无扩展名），抖音只下发 AvatarThumb
        ...(avatar ? { avatar } : {}),
        extra: {
          level: msg.user.PayGrade?.level ?? "0",
          clubLevel: msg.user.FansClub?.data?.level ?? "0",
        },
      },
    };

    // 单独使用groupId并不可靠
    const groupId = `${msg.groupId}_${msg.user.id}_${msg.giftId}`;

    // 如果已存在相同 groupId 的礼物,清除旧的定时器
    const existing = giftMessageCache.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // 创建新的定时器
    const timer = setTimeout(() => {
      const cachedGift = giftMessageCache.get(groupId);
      if (cachedGift) {
        // 延迟时间到,添加最终的礼物消息
        this.emit("Message", cachedGift.gift);
        extraDataController.addMessage(cachedGift.gift);
        giftMessageCache.delete(groupId);
      }
    }, GIFT_DELAY);

    // 更新缓存
    giftMessageCache.set(groupId, { gift, timer });
  });
  client.on("linkMic", (msg) => {
    void appendPkRawLog(downloader.videoFilePath, "linkMic", msg);
    const extraDataController = downloader.getExtraDataController();
    if (!extraDataController) return;
    if (this.savePk === false) return;
    // 昵称不进消息体、**也不在录制期查询**：`addMessage` 会把本场选手 uid 交给
    // controller 登记（`pkUidsSeen`），查询统一推迟到 `flush` 前批量完成
    // （见 `resolvePendingPkNicknames`）—— 有 battle 的场次因此零请求。
    //
    // 注意：`userScores` 可能缺失（普通连麦消息不含 user_scores），
    // 由 `buildPkScoreMessage` 内部兜底，无选手时返回 null。
    const pkScore = buildPkScoreMessage(msg, this.useServerTimestamp ?? true);
    if (!pkScore) return;
    extraDataController.addMessage(pkScore);
  });
  client.on("reconnect", (attempts: number) => {
    this.appendTimeline({ text: `弹幕连接断开，正在重试: ${attempts}` });
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma has reconnect ${attempts}`,
    });
  });
  client.on("error", (err) => {
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma error: ${String(err)}`,
    });
  });
  client.on("init", (url) => {
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma init ${url}`,
    });
  });
  client.on("open", () => {
    this.appendTimeline({ text: `弹幕连接已建立` });
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma open`,
    });
  });
  client.on("close", () => {
    this.emit("DebugLog", {
      type: "common",
      text: `douyin danma close`,
    });
  });

  // client.on("open", () => {
  //   console.log("open");
  // });
  // client.on("close", () => {
  //   console.log("close");
  // });
  // client.on("error", (err) => {
  //   console.log("error", err);
  // });
  // client.on("heartbeat", () => {
  //   // console.log("heartbeat");
  // });

  if (!this.disableProvideCommentsWhenRecording) {
    client.connect();
  }

  const downloaderArgs = downloader.getArguments();
  downloader.run();

  const cut = utils.singleton<RecordHandle["cut"]>(async () => {
    if (!this.recordHandle) return;
    downloader.cut();
  });

  const stop = singleton<RecordHandle["stop"]>(async (reason?: string) => {
    if (!this.recordHandle) return;
    this.emit("stateChange", { state: "stopping-record" });

    try {
      // 清理所有礼物缓存定时器
      for (const [_groupId, cached] of giftMessageCache.entries()) {
        clearTimeout(cached.timer);
        // 立即添加剩余的礼物消息
        const extraDataController = downloader.getExtraDataController();
        if (extraDataController) {
          this.emit("Message", cached.gift);
          extraDataController.addMessage(cached.gift);
        }
      }
      giftMessageCache.clear();

      // 输出昵称缓存统计：便于评估 PK 昵称的实际覆盖率
      if (pkStore.cache.size > 0 || pkStore.failed.size > 0) {
        let byBattle = 0;
        let byApi = 0;
        pkStore.cache.forEach((entry) => {
          if (entry.source === "battle") byBattle += 1;
          else byApi += 1;
        });
        const pkStats = pkChannelTracker.stats();
        this.emit("DebugLog", {
          type: "common",
          text:
            `[PK] 昵称缓存：共 ${pkStore.cache.size} 条` +
            `（battle ${byBattle} / api ${byApi}），查询失败 ${pkStore.failed.size} 条` +
            (pkStore.failed.size > 0
              ? `；无法获取昵称的 uid: ${[...pkStore.failed].join(", ")}`
              : "") +
            `；场次 ${pkStats.total} 场（开始建缓存 ${pkStats.byBattle} / 结束建缓存 ${pkStats.byBattleFinish}）`,
        });
      }

      client.close();
      await downloader.stop();
    } catch (err) {
      this.emit("DebugLog", {
        type: "common",
        text: `stop record error: ${String(err)}`,
      });
    }
    this.usedStream = undefined;
    this.usedSource = undefined;
    this.emit("RecordStop", { recordHandle: this.recordHandle, reason });
    this.recordHandle = undefined;
    this.liveInfo = undefined;
    this.emit("stateChange", { state: "idle" });
    this.cache.set("qualityRetryLeft", this.qualityRetry);
  });

  this.recordHandle = {
    id: genRecordUUID(),
    stream: stream.name,
    source: stream.source,
    recorderType: downloader.type,
    url: stream.url,
    downloaderArgs,
    savePath: downloader.videoFilePath,
    stop,
    cut,
  };
  this.emit("RecordStart", this.recordHandle);

  return this.recordHandle;
};

export const provider: RecorderProvider<{}> = {
  id: "DouYin",
  name: "抖音",
  siteURL: "https://live.douyin.com/",

  matchURL(channelURL) {
    // 支持 v.douyin.com 和 live.douyin.com
    return /https?:\/\/(live|v|www)\.douyin\.com\//.test(channelURL);
  },

  async resolveChannelInfoFromURL(channelURL) {
    if (!this.matchURL(channelURL)) return null;

    let id: string;
    if (channelURL.includes("v.douyin.com")) {
      // 处理短链接
      try {
        id = await resolveShortURL(channelURL);
      } catch (err: any) {
        throw new Error(`解析抖音短链接失败: ${err?.message}`);
      }
    } else if (channelURL.includes("/user/")) {
      // 解析用户主页
      id = await parseUser(channelURL);
      if (!id) {
        throw new Error(`解析抖音用户主页失败`);
      }
    } else {
      // 处理常规直播链接
      id = path.basename(new URL(channelURL).pathname);
    }
    const info = await getInfo(id);

    return {
      id: info.roomId,
      title: info.title,
      owner: info.owner,
      avatar: info.avatar,
      uid: info.uid,
    };
  },

  createRecorder(opts) {
    return createRecorder({ providerId: provider.id, ...opts });
  },

  fromJSON(recorder) {
    return defaultFromJSON(this, recorder);
  },

  setFFMPEGOutputArgs(args) {
    ffmpegOutputOptions.splice(0, ffmpegOutputOptions.length, ...args);
  },
};
