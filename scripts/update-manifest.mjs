import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, directory] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !directory) {
  throw new Error("Usage: node scripts/update-manifest.mjs VERSION ASSET_DIRECTORY");
}

const release = `https://github.com/zhaoguhong/filepace/releases/download/v${version}`;
const platforms = {
  "darwin-aarch64": "Filepace.app.tar.gz",
  "windows-x86_64": `Filepace_${version}_x64-setup.exe`,
};
const entries = Object.entries(platforms).map(([platform, name]) => {
  const signature = readFileSync(join(directory, `${name}.sig`), "utf8").trim();
  const trustedComment = Buffer.from(signature, "base64").toString("utf8")
    .split("\n").find((line) => line.startsWith("trusted comment: "));
  if (!trustedComment?.split("\t").includes(`version:${version}`)) {
    throw new Error(`The signature for ${name} does not bind v${version}`);
  }
  return [platform, { url: `${release}/${name}`, signature }];
});
writeFileSync(join(directory, "latest.json"), JSON.stringify({
  version,
  platforms: Object.fromEntries(entries),
}, null, 2) + "\n");
