# pnpm-dlx
Run `pnpm dlx` over `npx`, without requiring `pnpm` to already be installed.

## Usage

```bash
npx @cmdforge/pnpm-dlx <target> [--path <package.json path>] [--registry <url>] [--] [...args]
npx @cmdforge/pnpm-dlx --from-cwd [--path <package.json path>] [--] <pnpm args...>
```

Example:

```bash
npx @cmdforge/pnpm-dlx github:cmdforge/tip --path package.json -- ui open https://mcp.dev.azure.com
npx @cmdforge/pnpm-dlx --from-cwd -- dlx -y tip ui open https://mcp.dev.azure.com
```

The CLI:

1. Treats `github:<owner>/<repo>` and bare `<owner>/<repo>` targets as GitHub.
2. Fetches `--path` directly from GitHub raw content for GitHub targets.
3. Resolves a registry tarball URL with `npm view` for registry packages, using `--registry` or `https://registry.npmjs.org` by default.
4. In `--from-cwd` mode, reads the requested `package.json` from the current working directory and runs `npx pnpm@<version> <pnpm args...>`.
5. Otherwise, reads the requested remote `package.json`, extracts the `pnpm` version, then runs `npx pnpm@<version> dlx -y <target> [...args]`.

This avoids `npm pack` for GitHub targets, so package lifecycle scripts do not run before the `pnpm` version is known.

If the requested manifest does not exist, or its `packageManager` is not `pnpm@...`, the command fails with:

```text
pnpm not found at package/<resolved path>
```
