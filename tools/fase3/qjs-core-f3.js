// Fase 3: o @ps5-react/core da referencia do fixture: o de tools/memory/qjs-core.js com o sistema (ps5/ps4) e o firmware
// escolhidos pela variante (globalThis.__MEM_OS e __MEM_FIRMWARE, definidos antes de importar o app).
export * from '../memory/qjs-core.js';
import { DeviceInfo as BaseDevice } from '../memory/qjs-core.js';

export const Platform = { get OS() { return globalThis.__MEM_OS ?? 'ps5'; }, select: (spec) => spec[globalThis.__MEM_OS ?? 'ps5'] ?? spec.default };
export const DeviceInfo = { ...BaseDevice, get: () => ({ language: 'en-US', firmware: globalThis.__MEM_FIRMWARE || undefined }) };
