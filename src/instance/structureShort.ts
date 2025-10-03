import { createRoomShortcuts } from '@/modules/roomShortcuts/createRoomShortcuts';
import { bus } from './eventBus';
import { createEnvMethods } from '@/utils';

export const {
  getSpawn,
  getExtension,
  getRampart,
  getRoad,
  getWall,
  getKeeperLair,
  getPortal,
  getLink,
  getLab,
  getContainer,
  getTower,
  getPowerBank,
  getObserver,
  getPowerSpawn,
  getExtractor,
  getNuker,
  getFactory,
  getStorage,
  getTerminal,
  getInVaderCore,
  getSource,
  getMineral,
} = createRoomShortcuts({
  env: createEnvMethods('StructureShortcuts'),
  bus,
});
