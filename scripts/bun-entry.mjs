import html from "../src/ui/public/index.html" with { type: "text" };
import javascript from "../src/ui/public/app.js" with { type: "text" };
import css from "../src/ui/public/style.css" with { type: "text" };

globalThis.__UNI_PUSH_UI_ASSETS__ = {
  "ui/index.html": html,
  "ui/app.js": javascript,
  "ui/style.css": css,
};

const { main } = await import("../src/cli.js");
process.exitCode = await main(process.argv.slice(2));
