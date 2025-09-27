import { eventList } from './constants';
import { createBus } from './createBus';

(globalThis as any).EventList = eventList;

export default createBus;
