import express from 'express';
import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getRequestListeners = () => SourceRepository.get().objects<RequestListener>('@proteinjs/server-api/RequestListener');

export interface RequestListener extends Loadable {
    beforeRequest?(request: express.Request, response: express.Response): Promise<void>;
    afterRequest?(request: express.Request, response: express.Response): Promise<void>;
}