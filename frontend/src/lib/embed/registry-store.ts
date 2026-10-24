/**
 * 嵌入模式内存注册表的存放处。nova-models.ts 在嵌入模式下从这里读写，
 * 本文件只做类型导入，避免与 nova-models.ts 形成运行期循环依赖。
 */
import type { DefaultModels, NovaModelRegistry } from '@/lib/nova-models';

function emptyDefaults(): DefaultModels {
  return {
    textToImage: '',
    imageToImage: '',
    reversePrompt: '',
    agent: '',
    promptOptimize: '',
    imageDescribe: '',
    sliceDecomposition: '',
    sliceReconstruct: '',
    sliceImageEdit: '',
  };
}

function empty(): NovaModelRegistry {
  return { providers: [], imageModels: [], textModels: [], defaults: emptyDefaults() };
}

let memoryRegistry: NovaModelRegistry = empty();

export function getEmbedRegistry(): NovaModelRegistry {
  return {
    providers: [],
    imageModels: memoryRegistry.imageModels.map((model) => ({ ...model })),
    textModels: memoryRegistry.textModels.map((model) => ({ ...model })),
    defaults: { ...memoryRegistry.defaults },
  };
}

/** 设置页生成新注册表后整体替换。 */
export function setEmbedRegistry(registry: NovaModelRegistry): void {
  memoryRegistry = {
    providers: [],
    imageModels: registry.imageModels.map((model) => ({ ...model })),
    textModels: registry.textModels.map((model) => ({ ...model })),
    defaults: { ...emptyDefaults(), ...registry.defaults },
  };
}

/**
 * Nova 自身调用 saveRegistry（例如工作台里切换默认模型）时只合并 defaults，
 * 且只接受指向已有模型的值；不接受新增模型或 Key —— Key 只能在设置页「模型与密钥」里选。
 */
export function mergeEmbedRegistryDefaults(registry: Partial<NovaModelRegistry>): void {
  const ids = new Set([
    ...memoryRegistry.imageModels.map((model) => model.id),
    ...memoryRegistry.textModels.map((model) => model.id),
  ]);
  const next = { ...memoryRegistry.defaults };
  for (const [task, value] of Object.entries(registry.defaults || {}) as Array<[keyof DefaultModels, unknown]>) {
    if (typeof value === 'string' && (value === '' || ids.has(value)) && task in next) next[task] = value;
  }
  memoryRegistry = { ...memoryRegistry, defaults: next };
}

export function clearEmbedRegistry(): void {
  memoryRegistry = empty();
}

export function hasEmbedImageSelection(): boolean {
  return memoryRegistry.imageModels.length > 0;
}
