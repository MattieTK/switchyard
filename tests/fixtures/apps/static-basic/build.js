// Stands in for a static site generator: writes the site to build/.
const { mkdirSync, writeFileSync } = require("node:fs");
mkdirSync("build", { recursive: true });
writeFileSync("build/index.html", "<h1>Hello from a static site</h1>");
writeFileSync("build/404.html", "<h1>Not found</h1>");
