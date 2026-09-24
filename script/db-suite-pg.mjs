// Starts a real PostgreSQL 16 with no Docker, no apt and no system service: the binaries come from
// npm. Used by script/run-db-suite.sh so the database suite can run on any machine, including an
// agent sandbox. Same user, password, database and port as the pg-acceptance job in test.yml.
import EmbeddedPostgres from "embedded-postgres";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const pg = new EmbeddedPostgres({
  databaseDir: process.env.PGDATA_DIR || "/tmp/kamlife-pgdata",
  user: "kam", password: "kam", port: 5432, persistent: false,
  createPostgresUser: isRoot, onLog: () => {},
});
await pg.initialise();
await pg.start();
await pg.createDatabase("kamlife");
console.log("[db-suite] PostgreSQL 16 up on 127.0.0.1:5432, database kamlife");
const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
setInterval(() => {}, 1 << 30);
