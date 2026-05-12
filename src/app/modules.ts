import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';
import { createContext } from './runtime';

/**
 * 当前 AI 装配出的业务模块实例。
 *
 * modules 层只定义可复用工厂；app/modules.ts 负责把它们接到当前 runtime。
 */
export const roomShortcuts = createRoomShortcuts(
  createContext('StructureShortcuts')
);
