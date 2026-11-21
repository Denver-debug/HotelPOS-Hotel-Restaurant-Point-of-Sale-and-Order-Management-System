// Stages dist/hostinger from the last commit for Hostinger's Node.js hosting
// (docs/DEPLOY-HOSTINGER.md). Hostinger runs "npm install" and "npm run build", so the
// package.json there drops the Electron dev dependencies and has a build that only checks syntax.
//   node deploy/package-hostinger.js
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const stage = path.join(root, "dist", "hostinger");

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
// Committed files only: no .env, storage/ or uploads from this machine. A throwaway index
// leaves whatever is staged in the real one alone.
const index = path.join(root, "dist", "hostinger.index");
const git = (...args) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_INDEX_FILE: index } });
git("read-tree", "HEAD");
git("checkout-index", "-a", `--prefix=${path.relative(root, stage).replaceAll("\\", "/")}/`);
fs.rmSync(index);
for (const p of ["__tests__", "electron", "bin", "deploy"]) fs.rmSync(path.join(stage, p), { recursive: true, force: true });
for (const f of fs.readdirSync(stage)) if (f.endsWith(".docx")) fs.rmSync(path.join(stage, f));

const pkgFile = path.join(stage, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
delete pkg.devDependencies;
delete pkg.build;
delete pkg.bin;
pkg.main = "hostinger.cjs";
pkg.scripts = {
  start: "node hostinger.cjs",
  migrate: "node migrate.js",
  build: "node --check hostinger.cjs && node --check index.js",
};
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
// npm install prunes the Electron packages from package-lock.json and keeps the other pins.

console.log(`✅ ${path.relative(root, stage)} is ready to deploy`);
