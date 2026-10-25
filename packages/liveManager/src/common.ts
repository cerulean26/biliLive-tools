import { AnyObject, UnknownObject } from "./utils.js";

export type ChannelId = string;

export const Qualities = ["lowest", "low", "medium", "high", "highest"] as const;
export const DouyuQualities = [0, 2, 3, 4, 8] as const;
// 14100: 2K HDR；14000：2K；4200：HDR(10M)；0：原画；8000：蓝光8M；4000：蓝光4M；2000：超清；500：流畅
export const HuYaQualities = [
  0, 20000, 14100, 14000, 10000, 8000, 4200, 4000, 2000, 500, -1,
] as const;
export const DouYinQualities = ["origin", "uhd", "hd", "sd", "ld", "ao", "real_origin"] as const;
export type Quality = string | number;

export interface MessageSender<E extends AnyObject = UnknownObject> {
  uid?: string;
  name: string;
  avatar?: string;
  extra?: E;
}

export interface Comment<E extends AnyObject = UnknownObject> {
  type: "comment";
  timestamp: number;
  text: string;
  mode?: number;
  color?: string;
  sender?: MessageSender;
  extra?: E;
}

export interface GiveGift<E extends AnyObject = UnknownObject> {
  type: "give_gift";
  timestamp: number;
  name: string;
  count: number;
  price: number;
  text?: string;
  cost?: number;
  color?: string;
  /** 礼物图标的相对路径（抖音形如 webcast/xxx.png，由消费方自行拼 CDN 前缀） */
  imageUri?: string;
  /**
   * 礼物 ID。礼物名**不是**唯一标识（实测「点亮粉丝团」同时对应 giftId 6937/6938 且两图不同），
   * 只能靠 ID 区分，故消息上必须带它才能查图标表。
   * 用字符串承载：上游 proto 里是 uint64，运行时是 Long 对象。
   */
  giftId?: string;
  sender?: MessageSender;
  extra?: E;
}

export interface Guard<E extends AnyObject = UnknownObject> {
  type: "guard";
  timestamp: number;
  name: string;
  count: number;
  price: number;
  level: number;
  text?: string;
  cost?: number;
  color?: string;
  sender?: MessageSender;
  extra?: E;
}

export interface SuperChat<E extends AnyObject = UnknownObject> {
  type: "super_chat";
  timestamp: number;
  text: string;
  price: number;
  sender?: MessageSender;
  extra?: E;
}

export interface PkScore {
  type: "pk_score";
  timestamp: number;
  /**
   * 单场 PK 标识。一场直播可打多场 PK，快照只凭时间戳无法归属；
   * 由 `LinkMicMethod.battle_id` 带出。XSL 按它分组渲染，避免多场 PK 串成一张表。
   */
  battleId?: string;
  players: {
    uid: string;
    score: string;
    rank?: string;
    teamScore?: string;
    teamRank?: string;
  }[];
}

/**
 * 直播间在线人数采样。
 *
 * 值取自 `RoomStatsMessage.displayValue`（与 `total` 恒等）—— 这是唯一精确反映在线人数的字段：
 * `RoomUserSeqMessage` 的 `total` 是滞后快照（与 roomStats 同刻差 +219~-488，且随人数上升单调变负），
 * `onlineUserForAnchor` 是主播端口径的格式化文本（「1.3万」）。
 * 用字符串承载：proto 里是 int64，`toJSON()` 输出字符串。
 */
export interface RoomStats {
  type: "room_stats";
  timestamp: number;
  online: string;
}

/**
 * 直播间贡献榜（前三名）快照。
 *
 * 取自 `WebcastRoomRankMessage.ranks[]`：实测恒为 3 条、条目**只有** `user`（没有 `scoreStr`），
 * 未声明字段 3 里有显式 `rank` 1..9 且与数组下标严格对齐 —— 所以**数组顺序就是名次**，
 * 消息上不再单独带 rank 字段。
 *
 * ⚠️ 拿不到贡献值（`scoreStr`/`profileHidden` 实测 204/204 都没下发），只有「谁在榜上」。
 * ⚠️ 服务端把它当**状态广播**：同一份快照按 ~1.4 s 节拍重推，甚至换新 msgId 而内容逐字不变
 * （实测 30 s 收到 21 条，只有 3 个 msgId 且三者内容相同）。去重见控制器的 `lastRank`。
 */
export interface RoomRank {
  type: "room_rank";
  timestamp: number;
  /** 顺序即名次（index 0 = 第 1 名）。 */
  users: {
    uid: string;
    nick: string;
    /** 头像相对路径（实测全是 `100x100/aweme-avatar/…`，无扩展名，由消费方拼 CDN 前缀） */
    avatarUri?: string;
  }[];
}

export type Message = Comment | GiveGift | SuperChat | Guard | PkScore | RoomStats | RoomRank;
