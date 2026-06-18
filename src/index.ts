import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";

type ParsedArgs = {
  target: string;
  packageJsonPath: string;
  registry: string;
  forwardedArgs: string[];
};

type PackageJsonLike = {
  packageManager?: unknown;
  devEngines?: {
    packageManager?: unknown;
    pnpm?: unknown;
  };
};

type GitHubTarget = {
  owner: string;
  repo: string;
  ref: string;
};

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      "Usage: pnpm-dlx <target> [--path <package.json path>] [--registry <url>] [--] [...args]",
    );
  }

  const [target, ...rest] = argv;
  let packageJsonPath = "package.json";
  let registry = DEFAULT_REGISTRY;
  const forwardedArgs: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--") {
      forwardedArgs.push(...rest.slice(index + 1));
      break;
    }

    if (arg === "--path") {
      const value = rest[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --path");
      }

      packageJsonPath = value;
      index += 1;
      continue;
    }

    if (arg === "--registry") {
      const value = rest[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --registry");
      }

      registry = value;
      index += 1;
      continue;
    }

    forwardedArgs.push(arg);
  }

  return {
    target,
    packageJsonPath,
    registry,
    forwardedArgs: trimLeadingSeparator(forwardedArgs),
  };
}

export function trimLeadingSeparator(args: string[]): string[] {
  if (args[0] === "--") {
    return args.slice(1);
  }

  return args;
}

export function resolveTarEntryPath(packageJsonPath: string): string {
  const normalizedPath = posix.normalize(packageJsonPath.replaceAll("\\", "/"));
  const relativePath = normalizedPath.replace(/^\/+/, "");

  return `package/${relativePath || "package.json"}`;
}

export function isGitHubTarget(target: string): boolean {
  if (target.startsWith("github:")) {
    return true;
  }

  if (target.startsWith("@")) {
    return false;
  }

  return /^[^/@\s]+\/[^/#\s]+(?:#.+)?$/.test(target);
}

export function parseGitHubTarget(target: string): GitHubTarget {
  const normalized = target.startsWith("github:") ? target.slice(7) : target;
  const [repoPart, refPart] = normalized.split("#", 2);
  const segments = repoPart.split("/");

  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error(`Unsupported GitHub target: ${target}`);
  }

  return {
    owner: segments[0],
    repo: segments[1],
    ref: refPart || "HEAD",
  };
}

export function resolvePackageJsonPath(packageJsonPath: string): string {
  const normalizedPath = posix.normalize(packageJsonPath.replaceAll("\\", "/"));
  const relativePath = normalizedPath.replace(/^\/+/, "");

  return relativePath || "package.json";
}

export function buildGitHubRawUrl(
  target: GitHubTarget,
  packageJsonPath: string,
): string {
  const resolvedPath = resolvePackageJsonPath(packageJsonPath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return `https://raw.githubusercontent.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${encodeURIComponent(target.ref)}/${resolvedPath}`;
}

export function findTarEntry(buffer: Buffer, entryPath: string): Buffer | null {
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) {
      return null;
    }

    const name = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeField = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;

    if (fullName === entryPath) {
      return buffer.subarray(contentStart, contentEnd);
    }

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  return null;
}

export function extractPnpmVersion(
  packageJson: PackageJsonLike,
  resolvedPackageJsonPath: string,
): string {
  const packageManagerVersion = extractVersionFromPackageManagerString(
    packageJson.packageManager,
  );

  if (packageManagerVersion) {
    return packageManagerVersion;
  }

  const devEnginesVersion = extractVersionFromDevEngines(
    packageJson.devEngines?.packageManager,
  );

  if (devEnginesVersion) {
    return devEnginesVersion;
  }

  const legacyDevEnginesVersion = extractVersionFromDevEngines(
    packageJson.devEngines?.pnpm,
    "pnpm",
  );

  if (legacyDevEnginesVersion) {
    return legacyDevEnginesVersion;
  }

  throw new Error(`pnpm not found at ${resolvedPackageJsonPath}`);
}

function extractVersionFromPackageManagerString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^pnpm@([^+]+)(?:\+.*)?$/.exec(value);

  return match?.[1] ?? null;
}

function extractVersionFromDevEngines(
  value: unknown,
  expectedName = "pnpm",
): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const version = extractVersionFromDevEnginesEntry(entry, expectedName);

      if (version) {
        return version;
      }
    }

    return null;
  }

  return extractVersionFromDevEnginesEntry(value, expectedName);
}

function extractVersionFromDevEnginesEntry(
  value: unknown,
  expectedName: string,
): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as { name?: unknown; version?: unknown };

  if (entry.name !== expectedName || typeof entry.version !== "string") {
    return null;
  }

  return entry.version;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

async function runCommandCapture(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || `${command} exited with code ${code ?? 1}`,
          ),
        );
        return;
      }

      resolve(stdout);
    });
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Request failed for ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return await response.text();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Request failed for ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function downloadRegistryTarball(
  target: string,
  registry: string,
): Promise<string> {
  const workingDirectory = await mkdtemp(join(tmpdir(), "pnpm-dlx-"));

  try {
    const output = await runCommandCapture(
      "npm",
      ["view", target, "dist.tarball", "--json", "--registry", registry],
      workingDirectory,
    );
    const parsed = JSON.parse(output) as string | string[];
    const tarballUrl = Array.isArray(parsed) ? parsed[0] : parsed;

    if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
      throw new Error(`Unable to resolve tarball for ${target}`);
    }

    const tarballBuffer = await fetchBuffer(tarballUrl);
    const tarballPath = join(workingDirectory, "package.tgz");
    await writeFile(tarballPath, tarballBuffer);

    return tarballPath;
  } catch (error) {
    await rm(workingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function loadPackageJsonFromTarball(
  tarballPath: string,
  packageJsonPath: string,
): Promise<{ packageJson: PackageJsonLike; resolvedPackageJsonPath: string }> {
  const archive = await readFile(tarballPath);
  const tarBuffer = gunzipSync(archive);
  const resolvedPackageJsonPath = resolveTarEntryPath(packageJsonPath);
  const entry = findTarEntry(tarBuffer, resolvedPackageJsonPath);

  if (!entry) {
    throw new Error(`pnpm not found at ${resolvedPackageJsonPath}`);
  }

  return {
    packageJson: JSON.parse(entry.toString("utf8")) as PackageJsonLike,
    resolvedPackageJsonPath,
  };
}

async function loadPackageJsonFromGitHub(
  target: string,
  packageJsonPath: string,
): Promise<{ packageJson: PackageJsonLike; resolvedPackageJsonPath: string }> {
  const parsedTarget = parseGitHubTarget(target);
  const resolvedPackageJsonPath = resolvePackageJsonPath(packageJsonPath);
  const url = buildGitHubRawUrl(parsedTarget, packageJsonPath);

  try {
    const packageJsonText = await fetchText(url);

    return {
      packageJson: JSON.parse(packageJsonText) as PackageJsonLike,
      resolvedPackageJsonPath,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Request failed")) {
      throw new Error(`pnpm not found at ${resolvedPackageJsonPath}`);
    }

    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { target, packageJsonPath, registry, forwardedArgs } = parseArgs(argv);
  let packageJson: PackageJsonLike;
  let resolvedPackageJsonPath: string;
  let cleanupDirectory: string | undefined;

  try {
    if (isGitHubTarget(target)) {
      ({ packageJson, resolvedPackageJsonPath } = await loadPackageJsonFromGitHub(
        target,
        packageJsonPath,
      ));
    } else {
      const tarballPath = await downloadRegistryTarball(target, registry);
      cleanupDirectory = dirname(tarballPath);
      ({ packageJson, resolvedPackageJsonPath } =
        await loadPackageJsonFromTarball(tarballPath, packageJsonPath));
    }

    const pnpmVersion = extractPnpmVersion(packageJson, resolvedPackageJsonPath);

    await runCommand("npx", [
      "-y",
      `pnpm@${pnpmVersion}`,
      "dlx",
      "-y",
      target,
      ...forwardedArgs,
    ]);
  } finally {
    if (cleanupDirectory) {
      await rm(cleanupDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
