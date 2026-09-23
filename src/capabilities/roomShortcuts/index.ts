/**
 * 文件摘要
 *
 * 模块角色：capabilities/roomShortcuts 的公共出口，发布房间查询接口、服务令牌和现有工厂。
 *
 * 主要功能：RoomShortcuts 明确列出业务消费者可用的查询方法；RoomShortcutsService
 * 将服务名与接口绑定，供 App 发布和插件读取；工厂仍可用于独立装配。
 *
 * 技术要点：令牌在模块装载时创建一次，只含服务名；sweep 是提供者的内部维护入口，
 * 不属于消费者接口。服务对象由插件 setup 创建，缓存及订阅随插件激活和释放，不由本文件保存。
 */
import { defineService } from '@/contracts';

/** 面向消费者的只读查询能力；对象均为当前 tick 的 Screeps 对象，不跨 tick 保存。 */
export interface RoomShortcuts {
  getSpawn(roomName: string): StructureSpawn[];
  getExtension(roomName: string): StructureExtension[];
  getRampart(roomName: string): StructureRampart[];
  getRoad(roomName: string): StructureRoad[];
  getWall(roomName: string): StructureWall[];
  getKeeperLair(roomName: string): StructureKeeperLair[];
  getPortal(roomName: string): StructurePortal[];
  getLink(roomName: string): StructureLink[];
  getLab(roomName: string): StructureLab[];
  getContainer(roomName: string): StructureContainer[];
  getTower(roomName: string): StructureTower[];
  getPowerBank(roomName: string): StructurePowerBank[];
  getObserver(roomName: string): StructureObserver | undefined;
  getPowerSpawn(roomName: string): StructurePowerSpawn | undefined;
  getExtractor(roomName: string): StructureExtractor | undefined;
  getNuker(roomName: string): StructureNuker | undefined;
  getFactory(roomName: string): StructureFactory | undefined;
  getStorage(roomName: string): StructureStorage | undefined;
  getTerminal(roomName: string): StructureTerminal | undefined;
  getInVaderCore(roomName: string): StructureInvaderCore | undefined;
  getSource(roomName: string): Source[];
  getMineral(roomName: string): Mineral | undefined;
}

/** 服务名与消费者接口的固定关联；manifest.requires 仍声明提供者插件 id。 */
export const RoomShortcutsService =
  defineService<RoomShortcuts>('roomShortcuts');

export { createRoomShortcuts } from './createRoomShortcuts';
