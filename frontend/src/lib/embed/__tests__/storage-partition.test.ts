import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setEmbedModeForTests } from '@/lib/embed/mode';
import {
  installIndexedDbPartition,
  installLocalStoragePartition,
  setStoragePartition,
  storageKey,
} from '@/lib/embed/storage-partition';

describe('storageKey', () => {
  afterEach(() => {
    setEmbedModeForTests(null);
    setStoragePartition(null);
  });

  it('独立模式原样返回', () => {
    setEmbedModeForTests(false);
    setStoragePartition(7);
    expect(storageKey('nova-jobs')).toBe('nova-jobs');
  });

  it('嵌入模式加 u<userId>: 前缀且幂等', () => {
    setEmbedModeForTests(true);
    setStoragePartition(7);
    expect(storageKey('studio-prefs')).toBe('u7:studio-prefs');
    expect(storageKey('u7:studio-prefs')).toBe('u7:studio-prefs');
    setStoragePartition(8);
    expect(storageKey('studio-prefs')).toBe('u8:studio-prefs');
  });

  it('会话前（userId 未知）落到 u0:，不会写进任何真实用户分区', () => {
    setEmbedModeForTests(true);
    setStoragePartition(null);
    expect(storageKey('theme')).toBe('u0:theme');
  });
});

describe('localStorage 分区 shim', () => {
  let restore: () => void = () => undefined;

  beforeEach(() => {
    localStorage.clear();
    // sub2api 自己（同源）的键：不能被 Nova 读到或清掉
    localStorage.setItem('auth_token', 'parent-jwt');
    setEmbedModeForTests(true);
    setStoragePartition(7);
    restore = installLocalStoragePartition(localStorage);
  });

  afterEach(() => {
    restore();
    setEmbedModeForTests(null);
    setStoragePartition(null);
    localStorage.clear();
  });

  it('读写自动走当前用户分区，换用户后看不到上一个用户的数据', () => {
    localStorage.setItem('nova-jobs', '["a"]');
    expect(localStorage.getItem('nova-jobs')).toBe('["a"]');
    expect(localStorage.getItem('auth_token')).toBeNull();

    setStoragePartition(8);
    expect(localStorage.getItem('nova-jobs')).toBeNull();
    localStorage.setItem('nova-jobs', '["b"]');

    setStoragePartition(7);
    expect(localStorage.getItem('nova-jobs')).toBe('["a"]');
  });

  it('length / key / clear 只作用于当前分区', () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    setStoragePartition(8);
    localStorage.setItem('c', '3');
    setStoragePartition(7);
    expect(localStorage.length).toBe(2);
    expect([localStorage.key(0), localStorage.key(1)].sort()).toEqual(['a', 'b']);
    localStorage.clear();
    expect(localStorage.length).toBe(0);
    restore();
    restore = () => undefined;
    // 父页的键和其他用户分区都还在
    expect(localStorage.getItem('auth_token')).toBe('parent-jwt');
    expect(localStorage.getItem('u8:c')).toBe('3');
    expect(localStorage.getItem('u7:a')).toBeNull();
  });

  it('卸载后恢复原生行为', () => {
    restore();
    restore = () => undefined;
    localStorage.setItem('plain', 'x');
    expect(localStorage.getItem('plain')).toBe('x');
  });
});

describe('IndexedDB 库名分区 shim', () => {
  it('open / deleteDatabase / databases 都使用分区库名', async () => {
    const opened: string[] = [];
    const deleted: string[] = [];
    class FakeFactory {
      open(name: string) { opened.push(name); return {} as IDBOpenDBRequest; }
      deleteDatabase(name: string) { deleted.push(name); return {} as IDBOpenDBRequest; }
      async databases() { return [{ name: 'u7:nova-image-db', version: 1 }, { name: 'u8:nova-image-db', version: 1 }, { name: 'other', version: 1 }]; }
      cmp() { return 0; }
    }
    const factory = new FakeFactory() as unknown as IDBFactory;
    setEmbedModeForTests(true);
    setStoragePartition(7);
    const restore = installIndexedDbPartition(factory);
    try {
      factory.open('nova-image-db', 3);
      factory.open('nova-image'); // localforage 实例名
      factory.deleteDatabase('nova-agent-db');
      expect(opened).toEqual(['u7:nova-image-db', 'u7:nova-image']);
      expect(deleted).toEqual(['u7:nova-agent-db']);
      expect(await factory.databases()).toEqual([{ name: 'nova-image-db', version: 1 }]);
    } finally {
      restore();
      setEmbedModeForTests(null);
      setStoragePartition(null);
    }
  });
});
