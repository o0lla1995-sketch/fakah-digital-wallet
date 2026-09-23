// debug-sql.js — apply each migration file individually to locate the failure
const EmbeddedPostgres = require("embedded-postgres").default;
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: "/home/z/my-project/fakah/.pgdata2",
    user: "fakah", password: "fakah", port: 5434, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("fakah");
  const client = new Client({ connectionString: "postgres://fakah:fakah@127.0.0.1:5434/fakah" });
  await client.connect();

  const dir = path.join(__dirname, "..", "db");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf-8");
    try {
      await client.query(sql);
      console.log("OK  ", f);
    } catch (e) {
      console.log("FAIL", f, "->", e.message);
      if (e.position) {
        const pos = parseInt(e.position, 10);
        console.log("    context:", JSON.stringify(sql.slice(Math.max(0, pos - 120), pos + 80)));
      }
    }
  }
  await client.end();
  await pg.stop();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
