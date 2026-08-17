# create-ignex

Scaffold a new [Ignex](https://github.com) app. This package backs the
`npm create ignex` / `bun create ignex` entry points and forwards to the
[`@ignex/cli`](https://www.npmjs.com/package/@ignex/cli) `create` command.

## Usage

```sh
bun create ignex my-api
# or
npm create ignex@latest my-api
```

Ignex is Bun-first, so [Bun](https://bun.sh) ≥ 1.4 is required (the shim
re-executes the real CLI through Bun).

For the full scaffold-flag reference (features, runtime, package manager,
`--root`, …) see the [`@ignex/cli` README](../cli/README.md).
