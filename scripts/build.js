const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");

fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(publicDir, distDir, { recursive: true });
console.log(`Copied PWA assets to ${path.relative(root, distDir)}`);
