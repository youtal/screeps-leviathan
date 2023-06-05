import { log, Color } from "@/utils";

export function createProfiler(): Profiler {
  const defaultMemory = {
    data: {},
    total: 0,
  };

  function init() {
    if (!Memory.profiler) {
      Memory.profiler = defaultMemory;
      // 默认开启
      Memory.profiler.start = Game.time;
    }
    const toProfile = {
      Game: Game,
      Room: Room,
      RoomPosition: RoomPosition,
      Structure: Structure,
      Creep: Creep,
      Source: Source,
      Mineral: Mineral,
      ConstructionSite: ConstructionSite,
    };
    Object.keys(toProfile).forEach((key) => {
      profile(toProfile[key], key);
    });
    return "Profiler initialized";
  }

  return {
    init,
    start() {
      Memory.profiler.start = Game.time;
      return "Profiler started";
    },

    stop() {
      if (!isEnabled()) {
        return;
      }
      const timeRunning = Game.time - Memory.profiler.start!;
      Memory.profiler.total += timeRunning;
      delete Memory.profiler.start;
      return "Profiler stopped";
    },

    clear() {
      const running = isEnabled();
      Memory.profiler = defaultMemory;
      if (running) {
        Memory.profiler.start = Game.time;
      }
      return "Profiler Memory cleared";
    },

    reset() {
      delete Memory.profiler;
      init();
      return "Profiler Memory reset";
    },
    output() {
      outputProfilerData();
      return "Done";
    },

    status() {
      if (isEnabled()) {
        return "Profiler is running";
      }
      return "Profiler is stopped";
    },

    toString() {
      return (
        "Profiler.start() - Starts the profiler\n" +
        "Profiler.stop() - Stops/Pauses the profiler\n" +
        "Profiler.status() - Returns whether is profiler is currently running or not\n" +
        "Profiler.output() - Pretty-prints the collected profiler data to the console\n" +
        this.status()
      );
    },

    showMore() {
      Memory.profiler.showMore = true;
      return "Profiler will show more data";
    },

    showLess() {
      delete Memory.profiler.showMore;
      return "Profiler will show less data";
    },
  };
}

/**
 * 该方法会无条件包装对象的属性，无论其是一般方法还是get类方法，或是constructor
 * @param obj 待包装的对象
 * @param key 待包装的方法名
 * @param className 类名
 */
function wrapFunction(obj: object, _key: PropertyKey, className: string) {
  const descriptor = Reflect.getOwnPropertyDescriptor(obj, _key);
  if (!descriptor) return;

  const originalFunction = descriptor.value;
  const key = _key.toString();
  const memKey = className + `:${key}`;

  const savedName = `__${key}__`;
  if (Reflect.has(obj, savedName)) {
    return;
  }

  Reflect.set(obj, savedName, originalFunction);
  //log(`Wrapping ${memKey}`, "Profiler", Color.Green);
  //record(memKey, 0);
  Reflect.set(obj, key, function (this: any, ...args: any[]) {
    if (isEnabled()) {
      const start = Game.cpu.getUsed();
      const result = originalFunction.apply(this, args);
      const end = Game.cpu.getUsed();
      record(memKey, end - start);
      return result;
    }
    return originalFunction.apply(this, args);
  });
}

export function profile(target: Function): void;
export function profile(
  target: object,
  key: string | symbol,
  _descriptor: PropertyDescriptor
): void;
export function profile(target: Function, className: string): void;

/**
 *
 * @param target 待装饰的类
 * @param str2 当作为第二个重载的实现时，该参数为方法名，作为第三个重载的实现时，该参数为类名
 * @param _descriptor 仅在第二个重载的实现时存在，为方法的描述符
 * @returns
 */
export function profile(
  target: object | Function,
  str2?: string | symbol,
  _descriptor?: PropertyDescriptor
): void {
  if (_descriptor) {
    // 当target为类时，typeof target === "function"为true，此时target.name记录的是类名
    // 否则target为对象，此时target.constructor.name记录的是类名，但游戏中的对象的constructor.name都是空字符串，所以此时使用_.uniqueId("ProfiledClass")生成一个唯一的类名
    // 实际上这里绝大多数情况下typeof target === "function"为true，因为一旦对一个方法进行装饰，那么这个方法在被装饰时一定属于一个类而不是一个对象
    const className =
      typeof target === "function"
        ? target.name
        : target.constructor.name
        ? target.constructor.name
        : _.uniqueId("ProfiledClass");
    // case of method decorator
    wrapFunction(target, str2, className);
    return;
  }

  const className = str2
    ? str2.toString()
    : typeof target === "function"
    ? target.name
    : target.constructor.name && target.constructor.name !== "Object"
    ? target.constructor.name
    : _.uniqueId("ProfiledClass");

  const ctor = target as any;
  if (!ctor.prototype) {
    log(`Can't find prototype on ${className}`, "Profiler", Color.Yellow);
    return;
  }
  Reflect.ownKeys(ctor.prototype).forEach((k) => {
    //constructor、get、set方法不会被包装
    if (k === "constructor") return;
    const descriptor = Reflect.getOwnPropertyDescriptor(ctor.prototype, k);
    if (!descriptor) return;
    if (descriptor.get || descriptor.set) return;
    //log(`Wrapping ${className}:${k.toString()}`, "Profiler", Color.Green);
    wrapFunction(ctor.prototype, k, className);
  });
}

function isEnabled(): boolean {
  return Memory.profiler.start !== undefined;
}

function record(_key: string | symbol, time: number) {
  const key = _key.toString();
  if (!Memory.profiler.data[key]) {
    Memory.profiler.data[key] = {
      calls: 0,
      time: 0,
    };
  }
  Memory.profiler.data[key].calls++;
  Memory.profiler.data[key].time += time;
}

interface OutputData {
  name: string;
  calls: number;
  cpuPerCall: number;
  callsPerTick: number;
  cpuPerTick: number;
}

function outputProfilerData() {
  let totalTicks = Memory.profiler.total;
  if (Memory.profiler.start) {
    totalTicks += Game.time - Memory.profiler.start;
  }

  ///////
  // Process data
  let totalCpu = 0; // running count of average total CPU use per tick
  let calls: number;
  let time: number;
  let result: Partial<OutputData>;
  let data = Reflect.ownKeys(Memory.profiler.data).map((_key) => {
    const key = _key.toString();
    calls = Memory.profiler.data[key].calls;
    time = Memory.profiler.data[key].time;
    result = {};
    result.name = `${key}`;
    result.calls = calls;
    result.cpuPerCall = time / calls;
    result.callsPerTick = calls / totalTicks;
    result.cpuPerTick = time / totalTicks;
    totalCpu += result.cpuPerTick;
    return result as OutputData;
  });

  data.sort((lhs, rhs) => rhs.cpuPerTick - lhs.cpuPerTick);
  if (!Memory.profiler.showMore) _.slice(data, 0, 10);

  ///////
  // Format data
  let output = "";

  // get function name max length
  const longestName = _.max(data, (d) => d.name.length).name.length + 2;

  //// Header line
  output += _.padRight("Function", longestName);
  output += _.padLeft("Tot Calls", 12);
  output += _.padLeft("CPU/Call", 12);
  output += _.padLeft("Calls/Tick", 12);
  output += _.padLeft("CPU/Tick", 12);
  output += _.padLeft("% of Tot\n", 12);

  ////  Data lines
  data.forEach((d) => {
    output += _.padRight(`${d.name}`, longestName);
    output += _.padLeft(`${d.calls}`, 12);
    output += _.padLeft(`${d.cpuPerCall.toFixed(2)}ms`, 12);
    output += _.padLeft(`${d.callsPerTick.toFixed(2)}`, 12);
    output += _.padLeft(`${d.cpuPerTick.toFixed(2)}ms`, 12);
    output += _.padLeft(
      `${((d.cpuPerTick / totalCpu) * 100).toFixed(0)} %\n`,
      12
    );
  });

  output += `${totalTicks} total ticks measured`;
  output += `\t\t\t${totalCpu.toFixed(2)} average CPU profiled per tick`;
  console.log(output);
}

export function profileFunction(target: Function, prefix?: string) {
  const memKey = `${prefix ? prefix + "." : ""}${target.name}`;
  return function (...args: any[]) {
    if (isEnabled()) {
      const start = Game.cpu.getUsed();
      const result = target.apply(this, args);
      const end = Game.cpu.getUsed();
      record(memKey, end - start);
      return result;
    }
    return target.apply(this, args);
  };
}
