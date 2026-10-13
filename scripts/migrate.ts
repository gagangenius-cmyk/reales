import "dotenv/config";
import { createSequelize } from "../packages/database/src/connection";
import { createMigrator, resetDatabase } from "../packages/database/src/migrator";

async function main() {
  const cmd = process.argv[2] ?? "up";
  const sequelize = createSequelize();
  try {
    await sequelize.authenticate();
    if (cmd === "up") await createMigrator(sequelize).up();
    else if (cmd === "down") await createMigrator(sequelize).down();
    else if (cmd === "reset") await resetDatabase(sequelize);
    else throw new Error(`unknown command ${cmd}`);
  } finally {
    await sequelize.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
