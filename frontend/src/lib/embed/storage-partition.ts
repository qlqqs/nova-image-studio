/**
 * 浏览器存储按 sub2api 用户分区（docs/sub2api-embed.md §11）。
 *
 * storageKey(key) 给 localStorage 键与 localforage / IndexedDB 库名加 `u<userId>:` 前缀。
 * 为了不逐个改动上游几十处存储调用，嵌入模式启动时安装一层薄 shim：
 *   - Storage.prototype 上的 getItem / setItem / removeItem / key / length / clear
 *     只对 window.localStorage 生效（sessionStorage 不动），读写自动走 storageKey()；
 *   - IDBFactory.prototype.open / deleteDatabase / databases 对库名同样处理，
 *     localforage 的 IndexedDB 驱动最终也走 indexedDB.open，因而一并分区。
 * storageKey 幂等（已带当前前缀的键不再重复加），显式调用 storageKey() 的新代码与 shim 可共存。
 * 收到会话前（userId 未知）使用 `u0:`，正常流程里应用在会话到达前不会读写存储。
 */
import { isEmbedMode } from '@/lib/embed/mode';

let partitionUserId: number | null = null;

export function setStoragePartition(userId: number | null): void {
  partitionUserId = typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

export function getStoragePartition(): number | null {
  return partitionUserId;
}

export function storagePrefix(): string {
  if (!isEmbedMode()) return '';
  return `u${partitionUserId ?? 0}:`;
}

export function storageKey(key: string): string {
  const prefix = storagePrefix();
  if (!prefix) return key;
  const raw = String(key);
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
}

interface StorageOriginals {
  getItem: Storage['getItem'];
  setItem: Storage['setItem'];
  removeItem: Storage['removeItem'];
  key: Storage['key'];
  clear: Storage['clear'];
  length: PropertyDescriptor | undefined;
}

interface IdbOriginals {
  proto: IDBFactory;
  open: IDBFactory['open'];
  deleteDatabase: IDBFactory['deleteDatabase'];
  databases?: IDBFactory['databases'];
}

let storageRestore: (() => void) | null = null;
let idbRestore: (() => void) | null = null;

function findLengthDescriptor(proto: object): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(proto, 'length');
}

/** 安装 localStorage 分区 shim；返回卸载函数。重复调用返回同一个卸载函数。 */
export function installLocalStoragePartition(target: Storage | undefined = typeof window !== 'undefined' ? window.localStorage : undefined): () => void {
  if (storageRestore) return storageRestore;
  if (!target) return () => undefined;
  const proto = Object.getPrototypeOf(target) as Storage;
  const original: StorageOriginals = {
    getItem: proto.getItem,
    setItem: proto.setItem,
    removeItem: proto.removeItem,
    key: proto.key,
    clear: proto.clear,
    length: findLengthDescriptor(proto),
  };
  const rawLength = (storage: Storage): number => (original.length?.get ? original.length.get.call(storage) as number : 0);
  const partitionKeys = (storage: Storage): string[] => {
    const prefix = storagePrefix();
    const keys: string[] = [];
    const total = rawLength(storage);
    for (let i = 0; i < total; i++) {
      const name = original.key.call(storage, i);
      if (name !== null && name.startsWith(prefix)) keys.push(name.slice(prefix.length));
    }
    return keys;
  };

  proto.getItem = function getItem(this: Storage, key: string) {
    return original.getItem.call(this, this === target ? storageKey(String(key)) : key);
  };
  proto.setItem = function setItem(this: Storage, key: string, value: string) {
    return original.setItem.call(this, this === target ? storageKey(String(key)) : key, value);
  };
  proto.removeItem = function removeItem(this: Storage, key: string) {
    return original.removeItem.call(this, this === target ? storageKey(String(key)) : key);
  };
  proto.key = function key(this: Storage, index: number) {
    if (this !== target) return original.key.call(this, index);
    return partitionKeys(this)[index] ?? null;
  };
  proto.clear = function clear(this: Storage) {
    if (this !== target) return original.clear.call(this);
    // 只清当前用户分区，不碰 sub2api 自己（同源）的 localStorage
    for (const name of partitionKeys(this)) original.removeItem.call(this, storageKey(name));
  };
  if (original.length?.get) {
    const lengthGetter = original.length.get;
    Object.defineProperty(proto, 'length', {
      ...original.length,
      get(this: Storage) {
        return this === target ? partitionKeys(this).length : lengthGetter.call(this);
      },
    });
  }

  storageRestore = () => {
    proto.getItem = original.getItem;
    proto.setItem = original.setItem;
    proto.removeItem = original.removeItem;
    proto.key = original.key;
    proto.clear = original.clear;
    if (original.length) Object.defineProperty(proto, 'length', original.length);
    storageRestore = null;
  };
  return storageRestore;
}

/** 安装 IndexedDB 库名分区 shim；返回卸载函数。 */
export function installIndexedDbPartition(factory: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined): () => void {
  if (idbRestore) return idbRestore;
  if (!factory) return () => undefined;
  const proto = Object.getPrototypeOf(factory) as IDBFactory;
  const original: IdbOriginals = {
    proto,
    open: proto.open,
    deleteDatabase: proto.deleteDatabase,
    databases: proto.databases,
  };

  proto.open = function open(this: IDBFactory, name: string, version?: number) {
    const next = storageKey(String(name));
    return version === undefined ? original.open.call(this, next) : original.open.call(this, next, version);
  };
  proto.deleteDatabase = function deleteDatabase(this: IDBFactory, name: string) {
    return original.deleteDatabase.call(this, storageKey(String(name)));
  };
  if (typeof original.databases === 'function') {
    const databases = original.databases;
    proto.databases = async function filteredDatabases(this: IDBFactory) {
      const prefix = storagePrefix();
      const list = await databases.call(this);
      return list
        .filter((info) => typeof info.name === 'string' && info.name.startsWith(prefix))
        .map((info) => ({ ...info, name: (info.name as string).slice(prefix.length) }));
    };
  }

  idbRestore = () => {
    proto.open = original.open;
    proto.deleteDatabase = original.deleteDatabase;
    if (original.databases) proto.databases = original.databases;
    idbRestore = null;
  };
  return idbRestore;
}

export function installStoragePartition(): () => void {
  const restoreLocal = installLocalStoragePartition();
  const restoreIdb = installIndexedDbPartition();
  return () => {
    restoreLocal();
    restoreIdb();
  };
}
