import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import {
  buildGitHubRawUrl,
  extractPnpmVersion,
  findTarEntry,
  isGitHubTarget,
  parseGitHubTarget,
  parseArgs,
  resolvePackageJsonPath,
  resolveTarEntryPath,
  trimLeadingSeparator,
} from "./index.js";

function createTar(entries: Array<{ name: string; content: string }>): Buffer {
  const records: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(512, 0);

    header.write(entry.name, 0, 100, "utf8");
    header.write("0000777\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(sizeToOctal(content.length), 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.fill(0x20, 148, 156);
    header.write(checksum(header), 148, 8, "ascii");

    records.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512, 0));
  }

  records.push(Buffer.alloc(1024, 0));

  return Buffer.concat(records);
}

function sizeToOctal(size: number): string {
  return size.toString(8).padStart(11, "0") + "\0";
}

function checksum(header: Buffer): string {
  let sum = 0;

  for (const byte of header) {
    sum += byte;
  }

  return sum.toString(8).padStart(6, "0") + "\0 ";
}

test("parseArgs reads target, path, and forwarded args", () => {
  assert.deepEqual(
    parseArgs([
      "github:cmdforge/tip",
      "--path",
      "apps/ui/package.json",
      "--",
      "ui",
      "open",
    ]),
    {
      target: "github:cmdforge/tip",
      packageJsonPath: "apps/ui/package.json",
      registry: "https://registry.npmjs.org",
      fromCwd: false,
      forwardedArgs: ["ui", "open"],
    },
  );
});

test("parseArgs trims a leading forwarded separator", () => {
  assert.deepEqual(
    parseArgs(["github:cmdforge/tip", "--", "ui", "open"]),
    {
      target: "github:cmdforge/tip",
      packageJsonPath: "package.json",
      registry: "https://registry.npmjs.org",
      fromCwd: false,
      forwardedArgs: ["ui", "open"],
    },
  );
});

test("parseArgs reads a custom registry", () => {
  assert.deepEqual(
    parseArgs(["@scope/pkg", "--registry", "https://registry.example.com"]),
    {
      target: "@scope/pkg",
      packageJsonPath: "package.json",
      registry: "https://registry.example.com",
      fromCwd: false,
      forwardedArgs: [],
    },
  );
});

test("parseArgs supports from-cwd mode", () => {
  assert.deepEqual(parseArgs(["--from-cwd", "--", "dlx", "-y", "tip"]), {
    target: undefined,
    packageJsonPath: "package.json",
    registry: "https://registry.npmjs.org",
    fromCwd: true,
    forwardedArgs: ["dlx", "-y", "tip"],
  });
});

test("parseArgs supports from-cwd mode without an explicit separator", () => {
  assert.deepEqual(parseArgs(["--from-cwd", "install", "--frozen-lockfile"]), {
    target: undefined,
    packageJsonPath: "package.json",
    registry: "https://registry.npmjs.org",
    fromCwd: true,
    forwardedArgs: ["install", "--frozen-lockfile"],
  });
});

test("trimLeadingSeparator only removes the first separator", () => {
  assert.deepEqual(trimLeadingSeparator(["--", "ui", "--", "open"]), [
    "ui",
    "--",
    "open",
  ]);
});

test("resolveTarEntryPath normalizes the package.json path", () => {
  assert.equal(
    resolveTarEntryPath("/packages/app/package.json"),
    "package/packages/app/package.json",
  );
});

test("resolvePackageJsonPath normalizes a relative manifest path", () => {
  assert.equal(
    resolvePackageJsonPath("/packages/app/package.json"),
    "packages/app/package.json",
  );
});

test("isGitHubTarget matches github shorthand and skips scoped packages", () => {
  assert.equal(isGitHubTarget("github:cmdforge/tip"), true);
  assert.equal(isGitHubTarget("cmdforge/tip"), true);
  assert.equal(isGitHubTarget("@cmdforge/tip"), false);
  assert.equal(isGitHubTarget("tip"), false);
});

test("parseGitHubTarget handles github shorthand and refs", () => {
  assert.deepEqual(parseGitHubTarget("github:cmdforge/tip#main"), {
    owner: "cmdforge",
    repo: "tip",
    ref: "main",
  });
});

test("buildGitHubRawUrl points at the raw package.json path", () => {
  assert.equal(
    buildGitHubRawUrl(
      { owner: "cmdforge", repo: "tip", ref: "HEAD" },
      "/packages/ui/package.json",
    ),
    "https://raw.githubusercontent.com/cmdforge/tip/HEAD/packages/ui/package.json",
  );
});

test("findTarEntry returns a matching tar entry", () => {
  const tar = createTar([
    {
      name: "package/package.json",
      content: JSON.stringify({ packageManager: "pnpm@10.1.0" }),
    },
  ]);
  const entry = findTarEntry(tar, "package/package.json");

  assert.ok(entry);
  assert.deepEqual(JSON.parse(entry.toString("utf8")), {
    packageManager: "pnpm@10.1.0",
  });
});

test("extractPnpmVersion reads a pnpm packageManager version", () => {
  assert.equal(
    extractPnpmVersion(
      { packageManager: "pnpm@10.1.0+sha512.deadbeef" },
      "package/package.json",
    ),
    "10.1.0",
  );
});

test("extractPnpmVersion reads devEngines.packageManager", () => {
  assert.equal(
    extractPnpmVersion(
      {
        devEngines: {
          packageManager: {
            name: "pnpm",
            version: "10.2.1",
          },
        },
      },
      "package/package.json",
    ),
    "10.2.1",
  );
});

test("extractPnpmVersion reads devEngines.packageManager arrays", () => {
  assert.equal(
    extractPnpmVersion(
      {
        devEngines: {
          packageManager: [
            {
              name: "npm",
              version: "10",
            },
            {
              name: "pnpm",
              version: "9.12.0",
            },
          ],
        },
      },
      "package/package.json",
    ),
    "9.12.0",
  );
});

test("extractPnpmVersion falls back to legacy devEngines.pnpm", () => {
  assert.equal(
    extractPnpmVersion(
      {
        devEngines: {
          pnpm: {
            name: "pnpm",
            version: "8.15.7",
          },
        },
      },
      "package/package.json",
    ),
    "8.15.7",
  );
});

test("extractPnpmVersion errors when pnpm is missing", () => {
  assert.throws(
    () =>
      extractPnpmVersion(
        { packageManager: "npm@10.0.0" },
        "package/foo/package.json",
      ),
    /pnpm not found at package\/foo\/package\.json/,
  );
});

test("tar helper sanity check stays gzip-compatible", () => {
  const tar = createTar([{ name: "package/package.json", content: "{}" }]);
  const gzip = gzipSync(tar);

  assert.ok(gzip.length > 0);
});
