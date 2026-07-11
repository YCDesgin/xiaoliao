import { useState, useEffect } from 'react';
import * as syncService from '../services/syncService';

/**
 * 轻量 hook：订阅 syncService 的同步状态，供 SyncStatus / ChatView 等使用。
 * @returns {{state:string, error:string|null, lastSyncAt:number|null, retry:(contactId:string)=>void}}
 */
export function useSyncStatus() {
  const [status, setStatus] = useState(() => syncService.getStatus());

  useEffect(() => {
    const unsub = syncService.subscribe(setStatus);
    return unsub;
  }, []);

  const retry = (contactId) => syncService.manualSync(contactId).catch(() => {});

  return { ...status, retry };
}
