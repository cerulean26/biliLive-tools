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
  /**
   * 礼物 ID。礼物名**不是**唯一标识（实测「点亮粉丝团」同时对应 giftId 6937/6938 且两图不同），
   * 只能靠 ID 区分。
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

export type Message = Comment | GiveGift | SuperChat | Guard | PkScore;
