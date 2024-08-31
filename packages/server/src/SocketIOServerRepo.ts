import { Server as HttpServer, IncomingMessage } from 'http';
import { Socket, Server as SocketIOServer } from 'socket.io';
import { getDefaultSocketIOServerFactory } from '@proteinjs/event';

const getGlobal = (): any => {
  if (typeof window !== 'undefined') {
    return window;
  }

  return globalThis;
};

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
}
