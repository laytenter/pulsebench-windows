"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourceDirectory = path.join(projectRoot, "src");
const targetDirectory = path.join(projectRoot, "dist", "src");
const assetSource = path.join(projectRoot, "assets");
const assetTarget = path.join(projectRoot, "dist", "assets");

fs.mkdirSync(targetDirectory, { recursive: true });
fs.mkdirSync(assetTarget, { recursive: true });

for (const file of ["index.html", "styles.css"]) {
  fs.copyFileSync(path.join(sourceDirectory, file), path.join(targetDirectory, file));
}

for (const entry of fs.readdirSync(assetSource, { withFileTypes: true })) {
  if (entry.isFile()) {
    fs.copyFileSync(path.join(assetSource, entry.name), path.join(assetTarget, entry.name));
  }
}
