import WebSocket from "ws";
import { TypedEmitter } from "tiny-typed-emitter";
import Long from "long";
// 必须 import `/minimal` 而不是主入口：`proto.js` 用的是 `protobufjs/minimal`，
// 只有同一份模块实例，下面的 `util.Long = Long` 才能注入到解码器实际使用的 util。
// 带 `.js` 后缀是因为 protobufjs 无 `exports` 字段，Node16 解析不到裸子路径的类型；
// 而 protobufjs 的 files 里自带 `minimal.d.ts`，加后缀后 TS 可直接定位到它。
import * as protobufMinimal from "protobufjs/minimal.js";
import { decompressGzip, getXMsStub, getSignature, getUserUniqueId } from "./utils.js";
import protobuf from "./proto.js";

import { getCookie } from "./api.js";

/**
 * 【关键修复】显式注入 Long，避免 19 位 uint64 ID 在 decode 阶段被读成浮点数。
 *
 * 背景：
 * protobufjs 通过 `util.inquire("long")` 加载 long 库，而 @protobufjs/inquire 的实现是
 * `eval("require")("long")` —— 源码注释明写 "hides the call from bundlers"。
 * 打包器静态分析看不到这条依赖，long 不会进产物，运行时解析失败 → util.Long 为 null。
 *
 * 后果（protobufjs/src/reader.js 的 Reader._configure，注意 fn 只求值一次）：
 *   var fn = util.Long ? "toLong" : "toNumber";
 * util.Long 为 null 时 fn 被绑成 "toNumber"，所有 uint64 字段
 * （roomId / msgId / channelId / userId）在 decode 阶段就被读成 JS 浮点数，
 * 超过 2^53 的 19 位 ID 低位被抹零：
 *   7694659564742265636 → 7694659564742266000
 * 此后即便 toObject({ longs: String }) 也救不回来 —— 值已经是浮点数了。
 *
 * 修复：
 * 1. 用**静态 import** 引入 long（打包器可见，会被打进产物）
 * 2. 显式赋值 util.Long
 * 3. 调 configure() 让 Reader 重新绑定 fn = "toLong"
 */
protobufMinimal.util.Long = Long;
protobufMinimal.configure();

// 启动自检：宁可显式失败，也不要静默退化回 float64 而无人察觉
if (!protobufMinimal.util.Long) {
  throw new Error(
    "[DouYinDanma] Long 注入失败：protobufjs 的 util.Long 为空，19 位 ID 会丢失精度。" +
      "请检查 long 依赖是否已正确安装。",
  );
}

import type {
  ChatMessage,
  MemberMessage,
  LikeMessage,
  SocialMessage,
  GiftMessage,
  RoomUserSeqMessage,
  RoomStatsMessage,
  RoomRankMessage,
  Message,
  PrivilegeScreenChatMessage,
  ScreenChatMessage,
  LinkMicBattleMessage,
  LinkMicBattleFinishMessage,
  LinkMicMethodMessage,
} from "../types/types.js";

interface Events {
  init: (url: string) => void;
  open: () => void;
  close: () => void;
  reconnect: (count: number) => void;
  heartbeat: () => void;
  error: (error: Error) => void;
  chat: (message: ChatMessage) => void;
  member: (message: MemberMessage) => void;
  like: (message: LikeMessage) => void;
  social: (message: SocialMessage) => void;
  gift: (message: GiftMessage) => void;
  roomUserSeq: (message: RoomUserSeqMessage) => void;
  roomStats: (message: RoomStatsMessage) => void;
  roomRank: (message: RoomRankMessage) => void;
  privilegeScreenChat: (message: PrivilegeScreenChatMessage) => void;
  screenChat: (message: ScreenChatMessage) => void;
  linkMic: (message: LinkMicMethodMessage) => void;
  linkMicBattle: (message: LinkMicBattleMessage) => void;
  linkMicBattleFinish: (message: LinkMicBattleFinishMessage) => void;
  message: (message: Message) => void;
}

class DouYinDanmaClient extends TypedEmitter<Events> {
  private ws!: WebSocket;
  private roomId: string;
  private heartbeatInterval: number;
  private heartbeatTimer!: NodeJS.Timeout;
  private isHeartbeatRunning: boolean = false;
  private autoStart: boolean;
  private autoReconnect: number;
  private reconnectAttempts: number;
  private reconnectInterval: number;
  private cookie?: string;
  private timeoutInterval: number;
  private lastMessageTime: number;
  private timeoutTimer!: NodeJS.Timeout;
  private isTimeoutCheckRunning: boolean = false;
  private isReconnecting: boolean = false;
  private host: string;

  constructor(
    roomId: string,
    options: {
      autoStart?: boolean;
      autoReconnect?: number;
      heartbeatInterval?: number;
      reconnectInterval?: number;
      cookie?: string;
      timeoutInterval?: number;
      host?: string;
    } = {},
  ) {
    super();
    this.roomId = roomId;
    this.heartbeatInterval = options.heartbeatInterval ?? 10000;
    this.autoStart = options.autoStart ?? false;
    this.autoReconnect = options.autoReconnect ?? 10;
    this.reconnectAttempts = 0;
    this.reconnectInterval = options.reconnectInterval ?? 10000;
    this.cookie = options.cookie;
    this.timeoutInterval = options.timeoutInterval ?? 100000; // 默认100秒
    this.lastMessageTime = Date.now();
    this.host = options.host ?? "webcast100-ws-web-hl.douyin.com";

    if (this.autoStart) {
      this.connect();
    }
  }

  async connect() {
    const url = await this.getWsInfo(this.roomId);
    if (!url) {
      this.emit("error", new Error("获取抖音弹幕签名失败"));
      return;
    }
    this.emit("init", url);
    const cookies = this.cookie || (await getCookie());
    this.ws = new WebSocket(url, {
      headers: {
        Cookie: cookies,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        Origin: "https://live.douyin.com",
        Referer: "https://live.douyin.com/",
      },
    });

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.emit("open");
      this.startHeartbeat();
      this.startTimeoutCheck();
    });

    this.ws.on("message", (data) => {
      this.lastMessageTime = Date.now();
      this.decode(data as Buffer);
    });

    this.ws.on("close", () => {
      this.emit("close");
      this.reconnect();
    });

    this.ws.on("error", (error) => {
      this.emit("error", error);
      this.reconnect();
    });
  }

  send(data: any) {
    if (!this.ws) {
      return;
    }
    this.ws.send(data);
  }

  close() {
    if (!this.ws) {
      return;
    }
    this.reconnectAttempts = this.autoReconnect;
    this.stopHeartbeat();
    this.stopTimeoutCheck();

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  private startHeartbeat() {
    if (this.isHeartbeatRunning) {
      return;
    }

    this.stopHeartbeat();
    this.isHeartbeatRunning = true;

    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.emit("heartbeat");
        this.send(":\x02hb");
      } else {
        console.log("连接未就绪，当前状态:", this.ws.readyState);
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.isHeartbeatRunning = false;
    }
  }

  private startTimeoutCheck() {
    if (this.isTimeoutCheckRunning) {
      return;
    }

    this.stopTimeoutCheck();
    this.isTimeoutCheckRunning = true;

    // 重置最后消息时间，给连接一些初始化时间
    this.lastMessageTime = Date.now();
    this.timeoutTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastMessageTime > this.timeoutInterval) {
        console.log("No message received for too long, reconnecting...");
        // 在重连前重置时间，避免立即触发下一次重连
        this.lastMessageTime = now;
        this.reconnect();
      }
    }, 1000);
  }

  private stopTimeoutCheck() {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.isTimeoutCheckRunning = false;
    }
  }

  private reconnect() {
    if (this.isReconnecting) {
      return;
    }

    this.stopHeartbeat();
    this.stopTimeoutCheck();

    if (this.reconnectAttempts < this.autoReconnect) {
      this.isReconnecting = true;
      this.reconnectAttempts++;
      setTimeout(() => {
        this.connect();
        this.isReconnecting = false;
        this.emit("reconnect", this.reconnectAttempts);
      }, this.reconnectInterval);
    }
  }

  async handleMessage() {}

  /**
   * 处理弹幕消息
   */
  async handleChatMessage(chatMessage: ChatMessage) {
    this.emit("chat", chatMessage);
    this.emit("message", chatMessage);
  }

  /**
   * 处理进入房间
   */
  async handleEnterRoomMessage(message: MemberMessage) {
    this.emit("member", message);
    this.emit("message", message);
  }

  /**
   * 处理礼物消息
   */
  async handleGiftMessage(message: GiftMessage) {
    this.emit("gift", message);
    this.emit("message", message);
  }

  /**
   * 处理点赞消息
   */
  async handleLikeMessage(message: LikeMessage) {
    this.emit("like", message);
    this.emit("message", message);
  }

  /**
   * 处理social消息
   */
  async handleSocialMessage(message: SocialMessage) {
    this.emit("social", message);
    this.emit("message", message);
  }

  /**
   * 处理RoomUserSeqMessage
   */
  async handleRoomUserSeqMessage(message: RoomUserSeqMessage) {
    this.emit("roomUserSeq", message);
    this.emit("message", message);
  }

  /**
   * 处理 WebcastRoomStatsMessage
   */
  async handleRoomStatsMessage(message: RoomStatsMessage) {
    this.emit("roomStats", message);
    this.emit("message", message);
  }

  /**
   * 处理 WebcastRoomRankMessage
   */
  async handleRoomRankMessage(message: RoomRankMessage) {
    this.emit("roomRank", message);
    this.emit("message", message);
  }

  async handlePrivilegeScreenChatMessage(message: PrivilegeScreenChatMessage) {
    this.emit("privilegeScreenChat", message);
    this.emit("message", message);
  }

  async handleScreenChatMessage(message: ScreenChatMessage) {
    this.emit("screenChat", message);
    this.emit("message", message);
  }

  async handleLinkMicBattle(message: LinkMicBattleMessage) {
    this.emit("linkMicBattle", message);
    this.emit("message", message);
  }

  async handleLinkMicBattleFinish(message: LinkMicBattleFinishMessage) {
    this.emit("linkMicBattleFinish", message);
    this.emit("message", message);
  }

  async handleLinkMicMethod(message: LinkMicMethodMessage) {
    this.emit("linkMic", message);
    this.emit("message", message);
  }

  /**
   * 处理其他消息
   */
  async handleOtherMessage(message: any) {
    this.emit("message", message);
  }

  async decode(data: Buffer) {
    // @ts-ignore
    const PushFrame = protobuf.douyin.PushFrame;
    // @ts-ignore
    const Response = protobuf.douyin.Response;
    // @ts-ignore
    const ChatMessage = protobuf.douyin.ChatMessage;
    // @ts-ignore
    const RoomUserSeqMessage = protobuf.douyin.RoomUserSeqMessage;
    // @ts-ignore
    const MemberMessage = protobuf.douyin.MemberMessage;
    // @ts-ignore
    const GiftMessage = protobuf.douyin.GiftMessage;
    // @ts-ignore
    const LikeMessage = protobuf.douyin.LikeMessage;
    // @ts-ignore
    const SocialMessage = protobuf.douyin.SocialMessage;
    // @ts-ignore
    const RoomStatsMessage = protobuf.douyin.RoomStatsMessage;
    // @ts-ignore
    const RoomRankMessage = protobuf.douyin.RoomRankMessage;
    // @ts-ignore
    const PrivilegeScreenChatMessage = protobuf.douyin.PrivilegeScreenChatMessage;
    // @ts-ignore
    const ScreenChatMessage = protobuf.douyin.ScreenChatMessage;
    // @ts-ignore
    const LinkMicMethod = protobuf.douyin.LinkMicMethod;
    // @ts-ignore
    const LinkMicBattle = protobuf.douyin.LinkMicBattle;
    // @ts-ignore
    const LinkMicBattleFinish = protobuf.douyin.LinkMicBattleFinish;
    const wssPackage = PushFrame.decode(data);

    // @ts-ignore
    const logId = wssPackage.logId;

    let decompressed;
    try {
      // @ts-ignore
      if (wssPackage.payload instanceof Buffer) {
        // @ts-ignore
        decompressed = await decompressGzip(wssPackage.payload);
      } else {
        return;
      }
    } catch (e) {
      this.emit("error", e as Error);
      return;
    }

    const payloadPackage = Response.decode(decompressed);

    let ack = null;
    // @ts-ignore
    if (payloadPackage.needAck) {
      const obj = PushFrame.create({
        logId: logId,
        // @ts-ignore
        payloadType: payloadPackage.internalExt,
      });
      ack = PushFrame.encode(obj).finish();
    }

    const msgs: any[] = [];
    // @ts-ignore
    for (const msg of payloadPackage.messagesList) {
      // const now = new Date();
      try {
        if (msg.method === "WebcastChatMessage") {
          const chatMessage = ChatMessage.decode(msg.payload);
          this.handleChatMessage(chatMessage.toJSON() as ChatMessage);
        } else if (msg.method === "WebcastMemberMessage") {
          const memberMessage = MemberMessage.decode(msg.payload);
          this.handleEnterRoomMessage(memberMessage.toJSON() as MemberMessage);
        } else if (msg.method === "WebcastGiftMessage") {
          const giftMessage = GiftMessage.decode(msg.payload);
          this.handleGiftMessage(giftMessage.toJSON() as GiftMessage);
        } else if (msg.method === "WebcastLikeMessage") {
          const message = LikeMessage.decode(msg.payload);
          this.handleLikeMessage(message.toJSON() as LikeMessage);
        } else if (msg.method === "WebcastSocialMessage") {
          const message = SocialMessage.decode(msg.payload);
          this.handleSocialMessage(message.toJSON() as SocialMessage);
        } else if (msg.method === "WebcastRoomUserSeqMessage") {
          const message = RoomUserSeqMessage.decode(msg.payload);
          this.handleRoomUserSeqMessage(message.toJSON() as RoomUserSeqMessage);
        } else if (msg.method === "WebcastRoomStatsMessage") {
          const message = RoomStatsMessage.decode(msg.payload);
          this.handleRoomStatsMessage(message.toJSON() as RoomStatsMessage);
        } else if (msg.method === "WebcastRoomRankMessage") {
          const message = RoomRankMessage.decode(msg.payload);
          this.handleRoomRankMessage(message.toJSON() as RoomRankMessage);
        } else if (msg.method === "WebcastPrivilegeScreenChatMessage") {
          const message = PrivilegeScreenChatMessage.decode(msg.payload);
          this.handlePrivilegeScreenChatMessage(message.toJSON() as PrivilegeScreenChatMessage);
        } else if (msg.method === "WebcastScreenChatMessage") {
          const message = ScreenChatMessage.decode(msg.payload);
          this.handleScreenChatMessage(message.toJSON() as ScreenChatMessage);
        } else if (msg.method === "WebcastLinkMicMethod") {
          this.handleLinkMicMethod(
            LinkMicMethod.decode(msg.payload).toJSON() as LinkMicMethodMessage,
          );
        } else if (msg.method === "WebcastLinkMicBattleMethod") {
          this.handleLinkMicBattle(
            LinkMicBattle.decode(msg.payload).toJSON() as LinkMicBattleMessage,
          );
        } else if (msg.method === "WebcastLinkMicBattleFinishMethod") {
          this.handleLinkMicBattleFinish(
            LinkMicBattleFinish.decode(msg.payload).toJSON() as LinkMicBattleFinishMessage,
          );
        } else {
          // WebcastRanklistHourEntranceMessage,WebcastInRoomBannerMessage,WebcastRoomStreamAdaptationMessage
        }
      } catch (e) {
        console.error("error:", e, msg);
      }
    }
    if (ack) {
      this.send(ack);
    }
    return [msgs, ack];
  }
  async getWsInfo(roomId: string): Promise<string | undefined> {
    const userUniqueId = getUserUniqueId();
    // const userUniqueId = "7877922945687137703";
    const versionCode = 180800;
    const webcastSdkVersion = "1.0.15";

    const sigParams = {
      live_id: "1",
      aid: "6383",
      version_code: versionCode,
      webcast_sdk_version: webcastSdkVersion,
      room_id: roomId,
      sub_room_id: "",
      sub_channel_id: "",
      did_rule: "3",
      user_unique_id: userUniqueId,
      device_platform: "web",
      device_type: "",
      ac: "",
      identity: "audience",
    };

    let signature: string;
    try {
      const m = getXMsStub(sigParams);
      signature = getSignature(m); // 这里应该获取签名
    } catch (e) {
      return;
    }

    const webcast5Params = {
      app_name: "douyin_web",
      room_id: roomId,
      compress: "gzip",
      version_code: String(versionCode),
      webcast_sdk_version: webcastSdkVersion,
      update_version_code: webcastSdkVersion,
      live_id: "1",
      did_rule: "3",
      user_unique_id: userUniqueId,
      identity: "audience",
      signature: signature.toString(),
      device_platform: "web",
      cookie_enabled: "true",
      screen_width: "1920",
      screen_height: "1080",
      browser_language: "zh-CN",
      browser_platform: "Win32",
      browser_name: "Mozilla",
      browser_version:
        "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      browser_online: "true",
      tz_name: "Etc/GMT-8",
      host: "https://live.douyin.com",
      aid: "6383",
      endpoint: "live_pc",
      support_wrds: "1",
      im_path: "/webcast/im/fetch/",
      need_persist_msg_count: "15",
      heartbeatDuration: "0",
    };

    const wssUrl = `wss://${this.host}/webcast/im/push/v2/?${new URLSearchParams(webcast5Params).toString()}`;
    return wssUrl;
  }
}

export default DouYinDanmaClient;
