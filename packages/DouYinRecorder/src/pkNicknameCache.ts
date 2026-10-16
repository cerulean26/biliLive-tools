/**
 * PK 场次判定与去重策略。
 *
 * 这些逻辑原先散在 `index.ts` 的闭包里，无法被测试直接引用 ——
 * 结果测试只能在测试文件里手抄一份实现，生产代码改了它也照样通过，
 * 属于「假护栏」。抽到这里后，生产代码与测试共用同一份实现。
 *
 * ## 三态策略（配合分数消息的接口兜底，见 index.ts）
 *
 * - 场景 1「全程观看」：收到本场开始事件 → 用 battle 写缓存；结束事件跳过。
 * - 场景 2「中途加入且等到结束」：未收到开始事件、收到结束事件 → 用 battleFinish 写缓存。
 * - 场景 3「中途加入未等到结束」：两条事件都没收到 → 由分数消息触发接口查询兜底。
 */

/** 已处理场次的容量上限：长期录制累积过多时淘汰最旧的记录 */
export const PK_HANDLED_CHANNELS_LIMIT = 2000;

/** 场次缓存来源 */
export type PkHandleSource = "battle" | "battleFinish";

/**
 * 场次键：`battleId` —— 单场 PK 的唯一标识；取不到时返回 `null`（**不做去重**）。
 *
 * **为什么不用 `channelId`**（2026-10-14 实测）：它只表示「同一次开播」。样本：
 * 桃子🍑 一次录制含 3 场 PK（battleId 各异），channelId 全程恒为
 * 7696377304752362496 —— 拿它作键会把第 2、3 场判为「已处理过」而漏建缓存。
 *
 * **为什么不用 uid 集合兜底**（同日实测）：同一份样本里 3 场 PK 的选手**完全相同**
 * （连续的对手就是同一批人），uid 集合也完全相同 ⇒ 同样会误合并。
 * 「连打同一对手」是常态，所以这个兜底不可靠。
 *
 * **判不了就不去重**：重复写缓存无害（同 uid 同昵称，last-write-wins），
 * 而错误去重会**静默丢掉昵称**。故取不到 battleId 时返回 `null`，由调用方直接放行。
 *
 * @returns 场次键；无 `battleId` 时为 `null`
 */
export function buildBattleKey(battleSettings: { battleId?: string } | undefined): string | null {
  const battleId = battleSettings?.battleId;
  return battleId ? `b:${battleId}` : null;
}

/** 从 userInfos 里挑出可用的 `uid -> 昵称` 对（空值跳过） */
export function collectPkNicknames(
  userInfos: Record<string, { user?: { userId?: string; nickName?: string } }> | undefined,
): { uid: string; nickname: string }[] {
  const out: { uid: string; nickname: string }[] = [];
  for (const info of Object.values(userInfos ?? {})) {
    const user = info?.user;
    if (user?.userId && user.nickName) {
      out.push({ uid: user.userId, nickname: user.nickName });
    }
  }
  return out;
}

/**
 * 把 `userInfos` 的键从 protobufjs 的 int64 哈希串（乱码）归一化为真实 uid 字符串。
 *
 * 背景：`user_infos` 在 proto 里是 `map<int64, BattleUserInfo>`。protobufjs 解码 int64 类型的
 * map key 时，在 decode 阶段用 `$util.longToHash(key)` 把 Long 键转成 8 字节哈希串当对象键，
 * 该串 JSON 序列化后表现为乱码。`toObject({ longs: String })` 只作用于【值】的长整型字段、
 * 不影响【键】，所以键永远是那串不可读的哈希（实测 `LinkMicBattleFinish.userInfos` 的键为
 * `èP&£\x0e...` 之类的乱码，而值里的 `user.nickName` 完全正常）。
 *
 * 每个 value 内部本来就带 `user.user_id_str`（未舍入的字符串 uid，19 位也能保真），
 * 用它对键重排即可让数据可读、消除乱码。下游一律只读 `Object.values`，重排键不影响任何逻辑；
 * 反过来若不重排，未来若有人用 `userInfos[uid]` 按 uid 反查会静默失败（键是哈希）。
 *
 * 无 uid（罕见）或 uid 碰撞时保留原哈希键，避免丢数据。
 */
export function normalizeUserInfosKeys<
  T extends { user?: { userId?: string; userIdStr?: string; nickName?: string } },
>(userInfos: Record<string, T>): Record<string, T>;
export function normalizeUserInfosKeys(userInfos: undefined): undefined;
export function normalizeUserInfosKeys<
  T extends { user?: { userId?: string; userIdStr?: string; nickName?: string } },
>(userInfos: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!userInfos) return userInfos;
  // 用**无原型对象**聚合：新键来自 `user.userIdStr`（服务端可控的字符串）。
  // 若它是 `__proto__`，在普通对象字面量上 `out["__proto__"] = info` 会触发原型 setter
  // —— 不会污染 `Object.prototype`，但该键**不会成为自有属性**，导致这条记录被静默丢弃。
  // `Object.create(null)` 让所有键都走普通属性赋值；下游只读 `Object.values`，不受影响。
  const out: Record<string, T> = Object.create(null);
  for (const [hashKey, info] of Object.entries(userInfos)) {
    const uid = info?.user?.userIdStr || info?.user?.userId;
    const key = uid && !Object.prototype.hasOwnProperty.call(out, uid) ? uid : hashKey;
    out[key] = info;
  }
  return out;
}

/**
 * 场次去重追踪器。
 *
 * 语义：
 * - `acceptBattle`：同一场只放行第一次；若该场**已由结束事件处理过**则跳过
 *   （结束事件先到的极端情况，避免用开始事件的缓存反向覆盖）。
 * - `acceptBattleFinish`：同一场只放行第一次。
 * - 场次键为 `null`（无法判定场次）时**一律放行**，不做去重，也不阻断处理。
 */
export function createPkChannelTracker(limit: number = PK_HANDLED_CHANNELS_LIMIT) {
  const handled = new Map<string, PkHandleSource>();

  /** 记入已处理，并做容量保护（Map 的插入顺序即写入顺序，淘汰最旧） */
  const mark = (key: string, source: PkHandleSource): void => {
    if (!handled.has(key) && handled.size >= limit) {
      const oldest = handled.keys().next();
      if (!oldest.done) handled.delete(oldest.value);
    }
    if (!handled.has(key)) handled.set(key, source);
  };

  /**
   * 放行判定。
   *
   * 说明：这里不再单独判断「该场是否已由结束事件处理过」——
   * 那种情况已经被 `handled.has(key)` 覆盖（它对任何来源都拦截），
   * 单独判断属于死代码。这条是变异测试发现的：
   * 删掉那行判断后测试全绿，说明它从未被执行到。
   */
  const accept = (key: string | null, source: PkHandleSource): boolean => {
    if (!key) return true; // 无法判定场次 => 不去重，不阻断
    if (handled.has(key)) return false; // 同一场只放行第一次
    mark(key, source);
    return true;
  };

  return {
    /** @returns true = 应处理该场的开始事件；false = 应跳过 */
    acceptBattle(key: string | null): boolean {
      return accept(key, "battle");
    },
    /** @returns true = 应处理该场的结束事件；false = 应跳过 */
    acceptBattleFinish(key: string | null): boolean {
      return accept(key, "battleFinish");
    },
    /** 已记录的场次数（诊断/测试用） */
    get size(): number {
      return handled.size;
    },
    /** 查询某场次采用的缓存来源（诊断/测试用） */
    sourceOf(key: string): PkHandleSource | undefined {
      return handled.get(key);
    },
    /** 场次来源统计（诊断用） */
    stats(): { total: number; byBattle: number; byBattleFinish: number } {
      let byBattle = 0;
      let byBattleFinish = 0;
      for (const source of handled.values()) {
        if (source === "battle") byBattle += 1;
        else byBattleFinish += 1;
      }
      return { total: handled.size, byBattle, byBattleFinish };
    },
  };
}
