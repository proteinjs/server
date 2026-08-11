import { Server as HttpServer, IncomingMessage } from 'http';
import { Socket, Server as SocketIOServer } from 'socket.io';
import { getDefaultSocketIOServerFactory } from '@proteinjs/event';

const getGlobal = (): any => {
  if (typeof window !== 'undefined') {
    return window;
  }

  return globalThis;
};

// This package's socket.io is THE socket.io: consumers that type against the server it hosts
// (namespaces bound at startup, sockets in handlers) import these re-exports instead of
// declaring their own socket.io dependency — a second declaration forks the install into two
// copies whose identical-looking types are mutually unassignable (this package pins an exact
// version, so any caret range in a consumer resolves a different copy at install time).
export type { Namespace as SocketIONamespace, Socket as SocketIOSocket } from 'socket.io';

export interface ExtendedIncomingMessage extends IncomingMessage {
  sessionID?: string;
  user?: string;
}

export interface ExtendedSocket extends Socket {
  request: ExtendedIncomingMessage;
}

export class SocketIOServerRepo {
  static async createSocketIOServer(httpServer: HttpServer): Promise<SocketIOServer> {
    if (getGlobal().__proteinjs_server_SocketIOServer) {
      throw new Error('Socket IO Server already initialized');
    }

    const socketIOServerFactory = getDefaultSocketIOServerFactory();
    const socketIOServer = socketIOServerFactory
      ? await socketIOServerFactory.createSocketIOServer(httpServer)
      : new SocketIOServer(httpServer);
    getGlobal().__proteinjs_server_SocketIOServer = socketIOServer;

    return getGlobal().__proteinjs_server_SocketIOServer;
  }

  static getSocketIOServer(): SocketIOServer {
    if (!getGlobal().__proteinjs_server_SocketIOServer) {
      throw new Error(
        "Socket IO Server doesn'nt exist yet. You're likely calling this before @proteinjs/server has initialized it."
      );
    }

    return getGlobal().__proteinjs_server_SocketIOServer;
  }

  static getSocketIOServerIfExists(): SocketIOServer | undefined {
    return getGlobal().__proteinjs_server_SocketIOServer;
  }
}
