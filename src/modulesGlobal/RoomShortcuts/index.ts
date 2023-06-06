import { createShortcut } from "./roomshortcuts";
import { AppLifecycleCallbacks } from "@/freamWork/types";

const {
  init,
  updateStructure,
  getSpawn,
  getExtension,
  getRoad,
  getWall,
  getRampart,
  getKeeperLair,
  getPortal,
  getLink,
  getLab,
  getContainer,
  getSource,
  getTower,
  getPowerBank,
  getObserver,
  getPowerSpawn,
  getExtractor,
  getNuker,
  getFactory,
  getMineral,
  getInvaderCore,
} = createShortcut();
export const roomShortcutsPlugin: AppLifecycleCallbacks = {
  reload: () => {
    Object.defineProperties(Room.prototype, {
      STRUCTURE_SPAWN: {
        get: function () {
          return getSpawn(this);
        },
      },
      STRUCTURE_EXTENSION: {
        get: function () {
          return getExtension(this);
        },
      },
      STRUCTURE_ROAD: {
        get: function () {
          return getRoad(this);
        },
      },
      STRUCTURE_WALL: {
        get: function () {
          return getWall(this);
        },
      },
      STRUCTURE_RAMPART: {
        get: function () {
          return getRampart(this);
        },
      },
      STRUCTURE_KEEPER_LAIR: {
        get: function () {
          return getKeeperLair(this);
        },
      },
      STRUCTURE_PORTAL: {
        get: function () {
          return getPortal(this);
        },
      },
      STRUCTURE_LINK: {
        get: function () {
          return getLink(this);
        },
      },
      STRUCTURE_LAB: {
        get: function () {
          return getLab(this);
        },
      },
      STRUCTURE_CONTAINER: {
        get: function () {
          return getContainer(this);
        },
      },
      source: {
        get: function () {
          return getSource(this);
        },
      },
      STRUCTURE_TOWER: {
        get: function () {
          return getTower(this);
        },
      },
      STRUCTURE_POWER_BANK: {
        get: function () {
          return getPowerBank(this);
        },
      },
      STRUCTURE_OBSERVER: {
        get: function () {
          return getObserver(this);
        },
      },
      STRUCTURE_POWER_SPAWN: {
        get: function () {
          return getPowerSpawn(this);
        },
      },
      STRUCTURE_EXTRACTOR: {
        get: function () {
          return getExtractor(this);
        },
      },
      STRUCTURE_NUKER: {
        get: function () {
          return getNuker(this);
        },
      },
      STRUCTURE_FACTORY: {
        get: function () {
          return getFactory(this);
        },
      },
      mineral: {
        get: function () {
          return getMineral(this);
        },
      },
      STRUCTURE_INVADER_CORE: {
        get: function () {
          return getInvaderCore(this);
        },
      },
    });
  },
};

export { init, updateStructure };
