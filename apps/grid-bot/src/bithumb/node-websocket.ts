declare const require: (id: string) => unknown;

type WebSocketEventType = "open" | "message" | "close" | "error";

export interface WebSocketLike {
  addEventListener(type: WebSocketEventType, listener: (event?: any) => void): void;
  send(data: string): void;
  close(): void;
}

export function createWebSocket(url: string): WebSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (WebSocketCtor != null) {
    return new WebSocketCtor(url);
  }
  return new WsPackageWebSocket(url);
}

class WsPackageWebSocket implements WebSocketLike {
  private readonly socket: any;

  constructor(url: string) {
    const wsModule = require("ws") as { WebSocket?: new (url: string) => any } | (new (url: string) => any);
    const WsCtor = typeof wsModule === "function" ? wsModule : wsModule.WebSocket;
    if (WsCtor == null) {
      throw new Error("The ws package is installed but did not export WebSocket.");
    }
    this.socket = new WsCtor(url);
  }

  addEventListener(type: WebSocketEventType, listener: (event?: any) => void): void {
    if (type === "message") {
      this.socket.on("message", (data: unknown) => listener({ data }));
      return;
    }
    if (type === "error") {
      this.socket.on("error", (error: unknown) => listener({ error }));
      return;
    }
    this.socket.on(type, () => listener());
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }
}
