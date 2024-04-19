import asyncHooks from 'async_hooks';
import { SessionData, SessionDataStorage } from '@proteinjs/server-api';

export class NodeSessionDataStorage implements SessionDataStorage {
    private static HOOK_INITIALIZED = false;
    private static readonly SESSION_DATA: {[id: string]: SessionData} = {};
    environment = 'node' as 'node';

    setData(data: SessionData) {
        if (!NodeSessionDataStorage.HOOK_INITIALIZED)
            this.initHook();

        if (NodeSessionDataStorage.SESSION_DATA[asyncHooks.executionAsyncId()])
            return;

        NodeSessionDataStorage.SESSION_DATA[asyncHooks.executionAsyncId()] = data;
    }

    getData(): SessionData {
        if (!NodeSessionDataStorage.HOOK_INITIALIZED)
            this.initHook();

        return NodeSessionDataStorage.SESSION_DATA[asyncHooks.executionAsyncId()];
    }

    private initHook() {
        asyncHooks.createHook({
            init: (asyncId: number, type: string, triggerAsyncId: number, resource: Object) => {
                if (!NodeSessionDataStorage.SESSION_DATA[triggerAsyncId])
                    return;

                NodeSessionDataStorage.SESSION_DATA[asyncId] = NodeSessionDataStorage.SESSION_DATA[triggerAsyncId];
            },
            destroy: (asyncId: number) => {
                delete NodeSessionDataStorage.SESSION_DATA[asyncId];
            }
        }).enable();
        NodeSessionDataStorage.HOOK_INITIALIZED = true;
    }
}