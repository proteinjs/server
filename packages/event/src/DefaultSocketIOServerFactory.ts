import type { Server as HttpServer } from 'http';
import type { Server as SocketIOServer } from 'socket.io';
import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getDefaultSocketIOServerFactory = () =>
  SourceRepository.get().object<DefaultSocketIOServerFactory>('@proteinjs/event/DefaultSocketIOServerFactory');

export interface DefaultSocketIOServerFactory extends Loadable {
  createSocketIOServer(httpServer: HttpServer): SocketIOServer;
}
