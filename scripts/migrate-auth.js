import { getMigrations } from "better-auth/db/migration";
import { auth } from "../auth.js";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log("Better Auth schema migrated");
