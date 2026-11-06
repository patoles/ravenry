// The home folder of every machine the hub reaches, "" for this one: its
// own, then what each remote ravenryd says in hello (index.mjs sets them
// each tick). A folder is said against the home of the machine it is on,
// never this computer's (../public/homepath.mjs).

import os from 'node:os';
import { sayPath, sayPathOn } from '../public/homepath.mjs';

let homes = { '': os.homedir() };

export function setHomes(h) { homes = { '': os.homedir(), ...(h || {}) }; }
export function allHomes() { return homes; }

/** A folder on `machine` (null or "local" for this computer), said against that machine's home. */
export function sayFolder(p, machine) { return sayPathOn(p, machine, homes); }

/** A folder on this computer. */
export function sayLocal(p) { return sayPath(p, homes['']); }
