// src/lib/db/index.js - database driver selection.
//
// Drivers expose all(), get(), run(), exec(), transaction() and close().
// Queries use named {name} markers.

import { openSqlite } from './sqlite.js';

export const DIALECTS = ['sqlite'];

export async function openDatabase({ dialect = 'sqlite', path }) {
  switch (dialect) {
    case 'sqlite':
      return openSqlite({ database: { path } });
    default:
      throw new Error(`unsupported database dialect: ${dialect}`);
  }
}

export { runMigrations } from './migrate.js';
