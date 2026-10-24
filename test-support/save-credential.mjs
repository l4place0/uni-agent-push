import { saveStoredSecret } from "../src/secrets.js";

await saveStoredSecret(process.argv[2], process.argv[3], "dummy-value");
