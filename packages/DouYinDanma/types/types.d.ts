interface Common {
  method: string;
  msgId: string;
  roomId: string;
  isShowMsg: boolean;
  priorityScore?: string;
  foldType?: string;
  anchorFoldType?: string;
  anchorFoldTypeV2?: string;
  createTime?: string;
}

interface AvatarThumb {
  urlListList: string[];
  uri: string;
  avgColor: string;
}

interface BadgeImage {
  urlListList: string[];
  height: string;
  width: string;
  imageType: number;
  content: {
    level: string;
    alternativeText: string;
  };
}

interface User {
  id: string;
  nickName: string;
  AvatarThumb: AvatarThumb;
  BadgeImageList: BadgeImage[];
  Level?: string;
  PayGrade?: {
    level?: string;
  };
  FansClub?: {
    data?: {
      level?: string;
    };
  };
}

interface AnchorDisplayText {
  key: string;
  defaultPatter: string;
  defaultFormat: {
    color: string;
    weight: number;
  };
  piecesList: {
    type: boolean;
    format: {
      color: string;
      weight: number;
    };
  }[];
}

interface DisplayControlInfo {
  showText: boolean;
  showIcons: boolean;
}

interface Image {
  urlListList: string[];
  uri: string;
  avgColor: string;
}

interface Gift {
  image: Image;
  describe: string;
  id: string;
  forLinkmic: boolean;
  combo: boolean;
  type: number;
  diamondCount: number;
  isDisplayedOnPanel: boolean;
  name: string;
  icon: Image;
}

interface UserLabel {
  urlListList: string[];
  uri: string;
  avgColor: string;
}

interface PublicAreaCommon {
  userLabel: UserLabel;
}

interface Format {
  color: string;
  weight: number;
  useRemoteClor: boolean;
}

interface Piece {
  type: boolean;
  format: Format;
}

interface TrayDisplayText {
  key: string;
  defaultPatter: string;
  defaultFormat: Format;
  piecesList: Piece[];
}

interface Rank {
  user: User;
  rank: string;
}

export interface ChatMessage {
  common: Common & { method: "WebcastChatMessage" };
  user: User;
  content: string;
  /** 秒级时间戳 */
  eventTime: string;
  // giftImage: {
  //   urlListList: string[];
  //   width: string;
  //   content: Record<string, unknown>;
  // };
  // individualChatPriority: number;
}

export interface MemberMessage {
  common: Common & { method: "WebcastMemberMessage" };
  user: User;
  memberCount: string;
  action: string;
  anchorDisplayText: AnchorDisplayText;
  publicAreaCommon: Record<string, unknown>;
}

export interface LikeMessage {
  common: Common & { method: "WebcastLikeMessage" };
  count: string;
  total: string;
  user: User;
  displayControlInfo: DisplayControlInfo;
}

export interface SocialMessage {
  common: Common & { method: "WebcastSocialMessage" };
  user: User;
  action: string;
  shareTarget: string;
  followCount: string;
  publicAreaCommon: Record<string, unknown>;
}

export interface GiftMessage {
  common: Common & { method: "WebcastGiftMessage" };
  user: User;
  // 这个参数其实差不多是秒级时间戳，并不可靠
  groupId: string;
  giftId: number;
  gift: Gift;
  publicAreaCommon: PublicAreaCommon;
  trayDisplayText: TrayDisplayText;
  totalCount: string;
  clientGiftSource: number;
  sendTime: string;
  // repeatEnd 表示礼物连击完毕，这个为1时，sendTime值为秒级时间戳，否则为毫秒级时间戳
  repeatEnd: null | 1;
}

export interface RoomUserSeqMessage {
  common: Common & { method: "WebcastRoomUserSeqMessage" };
  ranksList: Rank[];
  total: string;
  totalUser: string;
  totalUserStr: string;
  totalStr: string;
  onlineUserForAnchor: string;
  totalPvForAnchor: string;
}

export interface RoomStatsMessage {
  common: Common & { method: "WebcastRoomStatsMessage" };
  displayShort: string;
  displayMiddle: string;
  displayLong: string;
  displayValue: string;
  displayVersion: string;
  total: string;
  displayType: string;
}

export interface RoomRankMessage {
  common: Common & { method: "WebcastRoomRankMessage" };
  ranks: {
    user: User;
  }[];
}

export interface PrivilegeScreenChatMessage {
  common: Common & { method: "WebcastPrivilegeScreenChatMessage" };
  user: User;
  content: string;
}

export interface ScreenChatMessage {
  common: Common & { method: "WebcastScreenChatMessage" };
  user: User;
  content: string;
  eventTime: string;
}

/**
 * PK 场次信息。用于判断「开始消息」与「结束消息」是否属于同一场 PK
 * （见 pkNicknameCache.ts 的 `buildBattleKey`）：
 * - **battleId 相同 => 同一场**（它是单场 PK 的唯一标识）
 * - 取不到 battleId => **不去重**（重复写缓存无害，误合并会静默丢昵称）
 * - 未收到开始消息 => 中途接入 => 缓存改用结束消息建立，不必等 API
 *
 * ⚠️ `channelId` **不参与判定**：它是开播场次级标识，一次开播内的多场 PK 共用它。
 * 实测样本：桃子🍑 一次录制 3 场 PK，channelId 恒为 7696377304752362496；
 * 三斤 roomId=7694659564742266000 的两场 PK channelId 均为 7694666908159841000。
 */
export interface BattleSettings {
  battleId?: string;
  channelId?: string;
}

export interface BattleUserEntry {
  user: {
    userId: string;
    nickName: string;
    /**
     * user_id 的字符串形式（未舍入的真实标识）。
     * user_id 会被 float64 舍入，19 位时低位被抹零导致查不到昵称；
     * 用此字段查询即可命中。normalizeUserInfosKeys 也优先用它作键。
     */
    userIdStr?: string;
  };
}

export interface LinkMicBattleMessage {
  common: Common & { method: "WebcastLinkMicBattleMethod" };
  battleSettings?: BattleSettings;
  userInfos: Record<string, BattleUserEntry>;
}

/**
 * PK 结束消息。
 * user_infos 的结构与 LinkMicBattle 完全一致，仅 method 与字段号（12vs 6）不同。
 *
 * ⛔ 不含 battleScores：`BattleScore` 已从 proto 整体删除（2026-10-14）——
 * 零消费方，且实测其字段与该场最后一条 linkMic 的 userScores 完全一致。
 */
export interface LinkMicBattleFinishMessage {
  common: Common & { method: "WebcastLinkMicBattleFinishMethod" };
  battleSettings?: BattleSettings;
  userInfos: Record<string, BattleUserEntry>;
}

/**
 * PK 选手实时分数。字段与 `dy.proto` 的 `LinkMicMethod.UserScores` 一致
 * （按实际消费方裁剪，2026-10-14）：
 *   score(1) / userId(2) / battleRank(8) / multiPkTeamScore(11) / multiPkTeamRank(12)
 *
 * 注意：`UserScores` **没有昵称字段**，故此处不声明 `nickName`。
 * PK 昵称只能从 battle / battleFinish 的 `userInfos` 取（经映射表落到 XML）。
 * 若在此声明，调用方写 `score.nickName` 会编译通过、运行时恒为 undefined —— 静默 bug。
 */
export interface UserScore {
  score: string;
  userId: string;
  battleRank?: string;
  multiPkTeamScore?: string;
  multiPkTeamRank?: string;
}

/** PK 实时分数消息。字段按实际消费方裁剪：common.createTime + userScores。 */
export interface LinkMicMethodMessage {
  common: Common & { method: "WebcastLinkMicMethod" };
  userScores: UserScore[];
  /** 单场 PK 的唯一标识（proto 字段 104）。实测 84/84 下发，值恒等于 BattleSettings.battleId。 */
  battleId?: string;
}

export type Message =
  | ChatMessage
  | MemberMessage
  | LikeMessage
  | SocialMessage
  | GiftMessage
  | RoomUserSeqMessage
  | RoomStatsMessage
  | RoomRankMessage
  | PrivilegeScreenChatMessage
  | ScreenChatMessage
  | LinkMicBattleMessage
  | LinkMicBattleFinishMessage
  | LinkMicMethodMessage;
