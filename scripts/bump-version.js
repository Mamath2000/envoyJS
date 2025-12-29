import fs from "node:fs";

function parseSemver(version) {
  const m = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Version invalide (attendu x.y.z): ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function bump(v, kind) {
  if (kind === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (kind === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  if (kind === "patch") return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  throw new Error(`Type de bump inconnu: ${kind} (attendu patch|minor|major)`);
}

function readJson(filePath) {
  const txt = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(txt);
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

const kind = process.argv[2] || "patch";
const pkgPath = new URL("../package.json", import.meta.url);
const pkgFile = pkgPath.pathname;

const pkg = readJson(pkgFile);
const current = parseSemver(pkg.version);
const next = bump(current, kind);
const nextStr = formatSemver(next);

pkg.version = nextStr;
writeJson(pkgFile, pkg);

// Met à jour package-lock.json si présent (npm v7+)
const lockFile = new URL("../package-lock.json", import.meta.url).pathname;
if (fs.existsSync(lockFile)) {
  const lock = readJson(lockFile);
  if (typeof lock.version === "string" || typeof lock.version === "number") {
    lock.version = nextStr;
  }
  if (lock.packages && lock.packages[""] && typeof lock.packages[""].version === "string") {
    lock.packages[""].version = nextStr;
  }
  writeJson(lockFile, lock);
}

console.log(nextStr);
