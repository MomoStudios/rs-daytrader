import { Kysely, MysqlDialect } from 'kysely';
import type { Dialect, LogEvent } from 'kysely';
import { createPool } from 'mysql2';

import { DB } from '#/db/types.js';
import Environment from '#/util/Environment.js';

let dialect: Dialect;

// Every worker thread (login, logger, friend, web) opens its own connection to the same
// file. WAL lets readers proceed while another thread writes (rollback-journal mode
// blocks the whole DB), and busy_timeout makes a contending writer wait instead of
// throwing SQLITE_BUSY immediately — without these, a burst of logger writes (e.g.
// telemetry compaction during a post-deploy reconnect storm) starves login queries and
// players see "login server offline". WAL adds db.sqlite-wal/-shm files; file-copy
// backups must checkpoint first (sqlite3 db.sqlite ".backup out.db").
const SQLITE_PRAGMAS = "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;";

if (Environment.db.backend === 'sqlite') {
    // rs-sdk: Bun has no node:sqlite — pick the dialect for the active runtime.
    if (typeof Bun !== 'undefined') {
        const { BunSqliteDialect } = await import('#/db/dialect/BunSqliteDialect.js');
        const { Database } = await import('bun:sqlite');

        const database = new Database('db.sqlite');
        database.exec(SQLITE_PRAGMAS);
        dialect = new BunSqliteDialect({
            database
        });
    } else {
        const { NodeSqliteDialect } = await import('#/db/dialect/NodeSqliteDialect.js');
        const { DatabaseSync } = await import('node:sqlite');

        const database = new DatabaseSync('db.sqlite');
        database.exec(SQLITE_PRAGMAS);
        dialect = new NodeSqliteDialect({
            database
        });
    }
} else {
    dialect = new MysqlDialect({
        pool: async () =>
            createPool({
                database: Environment.db.name,
                host: Environment.db.host,
                port: Environment.db.port,
                user: Environment.db.user,
                password: Environment.db.pass,
                timezone: 'Z'
            })
    });
}

function logVerbose(event: LogEvent) {
    if (event.level === 'query') {
        console.log(event.query.sql);
        console.log(event.query.parameters);
    }
}

export const db = new Kysely<DB>({
    dialect,
    log: Environment.db.verbose ? logVerbose : []
});

export function toDbDate(date: Date | string | number) {
    if (typeof date === 'string' || typeof date === 'number') {
        date = new Date(date);
    }

    return date.toISOString().slice(0, 19).replace('T', ' ');
}
