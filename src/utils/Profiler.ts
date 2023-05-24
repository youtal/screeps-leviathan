let functionCostMap:Record<string, {called: number, cost: number}> = {};

const recordCost = (fnName: string, cost: number) => {
    if (!functionCostMap[fnName]) {
        functionCostMap[fnName] = {
            called: 0,
            cost: 0,
        }
    }
    functionCostMap[fnName].called++;
    functionCostMap[fnName].cost += cost;
}

const registerFN = (fn: Function, fnName?: string) => {
    fnName = fnName || fn.name;
    return (...args: any[]) => {
        const start = Game.cpu.getUsed();
        const result = fn(...args);
        const end = Game.cpu.getUsed();
        recordCost(fnName, end - start);
        return result;
    }
}

const ObjectToRecord = {
    'Game': Game,
    'Structure': Structure,
    'Creep': Creep,
    'Room': Room,
    'RoomPosition': RoomPosition,
    'Source': Source,
}

const registerObject = () => {
    for (const key in ObjectToRecord) {
        const obj = ObjectToRecord[key];
        for (const name in obj) {
            const fn = obj[name];
            if (typeof fn === 'function') {
                obj.prototype[name] = registerFN(fn, `${key}.${name}`);
            }
        }
    }
}

const output = () => {
    return JSON.stringify(functionCostMap, null, 2);
}

export default {
    registerFN,
    registerObject,
    output,
}