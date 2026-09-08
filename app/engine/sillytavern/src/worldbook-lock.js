import path from 'node:path';
import { KeyedLock } from './nora-world-core/locks.js';

const locks = new KeyedLock();

// All HTTP and World Core writers serialize against the physical file, not a resource ID.
export function withWorldbookLock(filePath, operation) {
    return locks.run(path.resolve(filePath), operation);
}
