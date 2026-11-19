// node --import tools/no-playwright.mjs server/index.mjs: a board that
// resolves no Playwright, as the installed app's hub (Playwright is a
// development dependency it never ships). A test that proves a feature
// works in the installed app starts its board this way.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, next) {
  if (/^playwright(-core)?($|\\/)/.test(s)) { const e = new Error("Cannot find package '" + s + "'"); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; }
  return next(s, c);
}`));
