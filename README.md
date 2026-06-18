# pnpm-dlx
Run `pnpm dlx` over `npx`, without requiring `pnpm` to already be installed.

## Usage

```bash
npx @cmdforge/pnpm-dlx <target> [--path <package.json path>] [--registry <url>] [--] [...args]
```

Example:

```bash
npx @cmdforge/pnpm-dlx github:cmdforge/tip --path package.json -- ui open https://mcp.dev.azure.com
```

The CLI:

1. Treats `github:<owner>/<repo>` and bare `<owner>/<repo>` targets as GitHub.
2. Fetches `--path` directly from GitHub raw content for GitHub targets.
3. Resolves a registry tarball URL with `npm view` for registry packages, using `--registry` or `https://registry.npmjs.org` by default.
4. Reads the requested `package.json`, extracts the `pnpm` version from `packageManager`, then runs `npx pnpm@<version> dlx <target> [...args]`.

This avoids `npm pack` for GitHub targets, so package lifecycle scripts do not run before the `pnpm` version is known.

If the requested manifest does not exist, or its `packageManager` is not `pnpm@...`, the command fails with:

```text
pnpm not found at package/<resolved path>
```
