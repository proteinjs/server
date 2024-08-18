# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.7.2](https://github.com/proteinjs/server/compare/@proteinjs/server@1.7.1...@proteinjs/server@1.7.2) (2024-08-18)


### Bug Fixes

* use different file type for favicon ([2897442](https://github.com/proteinjs/server/commit/28974421fc89def80062f60b4a3f58bbedc0dda3))





# [1.7.0](https://github.com/proteinjs/server/compare/@proteinjs/server@1.6.1...@proteinjs/server@1.7.0) (2024-08-16)


### Features

* added `Request` to track request metadata in an async_hook ([c87cb0a](https://github.com/proteinjs/server/commit/c87cb0aaf1da85f36ca560e8e2c5e062bb98bf1c))





# [1.6.0](https://github.com/proteinjs/server/compare/@proteinjs/server@1.5.3...@proteinjs/server@1.6.0) (2024-08-02)


### Features

* added `StartupTask` ([d66616a](https://github.com/proteinjs/server/commit/d66616a2696c001c8ebef6828d319af6aeba245c))





## [1.5.2](https://github.com/proteinjs/server/compare/@proteinjs/server@1.5.1...@proteinjs/server@1.5.2) (2024-07-28)


### Bug Fixes

* no longer compress responses by default; compression should be handled explicitly within services/routes when needed. ([a33f5fb](https://github.com/proteinjs/server/commit/a33f5fb537943424f71072cf5f93d1edaa2c610c))





# [1.5.0](https://github.com/proteinjs/server/compare/@proteinjs/server@1.4.5...@proteinjs/server@1.5.0) (2024-07-20)


### Features

* added support for Socket.IO ([77c29a4](https://github.com/proteinjs/server/commit/77c29a4ddfd190f50ee38a0f80e118700eb417e0))





# [1.4.0](https://github.com/proteinjs/server/compare/@proteinjs/server@1.3.7...@proteinjs/server@1.4.0) (2024-07-06)


### Features

* resolve path for node modules react query ([70a75b2](https://github.com/proteinjs/server/commit/70a75b22130c5a81b120856006435461690748de))





## [1.3.4](https://github.com/proteinjs/server/compare/@proteinjs/server@1.3.3...@proteinjs/server@1.3.4) (2024-06-26)


### Bug Fixes

* add shim for `path` in webpack.config for hot builds ([1a0ec62](https://github.com/proteinjs/server/commit/1a0ec62c2bfb235979f251da851ca24908c916bd))





# [1.3.0](https://github.com/proteinjs/server/compare/@proteinjs/server@1.2.6...@proteinjs/server@1.3.0) (2024-06-15)


### Features

* add css loader to webpack.config used in hot builds ([37ae9bd](https://github.com/proteinjs/server/commit/37ae9bdc99602b59aed8544cf7f3eb68cd3d29cd))





## [1.2.4](https://github.com/proteinjs/server/compare/@proteinjs/server@1.2.3...@proteinjs/server@1.2.4) (2024-05-25)

**Note:** Version bump only for package @proteinjs/server





## [1.2.2](https://github.com/proteinjs/server/compare/@proteinjs/server@1.2.1...@proteinjs/server@1.2.2) (2024-05-18)


### Bug Fixes

* global getDataByKey using wrong object to get cache ([31d9c2a](https://github.com/proteinjs/server/commit/31d9c2ae4ffa6d4b12559a091e52c68482d3d4c6))





# [1.2.0](https://github.com/proteinjs/server/compare/@proteinjs/server@1.1.8...@proteinjs/server@1.2.0) (2024-05-18)


### Features

* create global data storage and cache ([52725b5](https://github.com/proteinjs/server/commit/52725b52820ae51022ef5a8132e44104e63193a9))





## [1.1.6](https://github.com/proteinjs/server/compare/@proteinjs/server@1.1.5...@proteinjs/server@1.1.6) (2024-05-16)


### Bug Fixes

* `reactApp` adds hot client build bundle names explicitly as script tags when hot client builds are enabled ([a585f90](https://github.com/proteinjs/server/commit/a585f9040587dae550c76c24827dfefc4af55127))





## [1.1.4](https://github.com/proteinjs/server/compare/@proteinjs/server@1.1.3...@proteinjs/server@1.1.4) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([38899a8](https://github.com/proteinjs/server/commit/38899a83c80b3d6dc61049dc48916168985acf87))





## [1.1.3](https://github.com/proteinjs/server/compare/@proteinjs/server@1.1.2...@proteinjs/server@1.1.3) (2024-05-10)


### Bug Fixes

* add linting and lint all files ([2b4e1e6](https://github.com/proteinjs/server/commit/2b4e1e6332e16328c3a3d3c846def74f819bbf39))





# [1.1.0](https://github.com/proteinjs/server/compare/@proteinjs/server@1.0.17...@proteinjs/server@1.1.0) (2024-05-06)

### Features

- `ServerConfig` now accepts a bundles directory instead of bundle paths (deprecated) so the server can support dynamic bundle names (ie. when you generate a hash as part of the bundle name for cache busting) ([f3d7cef](https://github.com/proteinjs/server/commit/f3d7cefd58cb0b220470e886e161fbc028ca2df9))

## [1.0.11](https://github.com/proteinjs/server/compare/@proteinjs/server@1.0.10...@proteinjs/server@1.0.11) (2024-04-24)

### Bug Fixes

- `ServerConfig` now requires a node_modules path to use hot client builds ([d0d14bd](https://github.com/proteinjs/server/commit/d0d14bda27e391ddb6493c714f5cf5220c1976fc))

## [1.0.9](https://github.com/proteinjs/server/compare/@proteinjs/server@1.0.8...@proteinjs/server@1.0.9) (2024-04-20)

**Note:** Version bump only for package @proteinjs/server

## [1.0.8](https://github.com/proteinjs/server/compare/@proteinjs/server@1.0.7...@proteinjs/server@1.0.8) (2024-04-19)

**Note:** Version bump only for package @proteinjs/server

## [1.0.7](https://github.com/brentbahry/server/compare/@proteinjs/server@1.0.6...@proteinjs/server@1.0.7) (2024-04-19)

### Bug Fixes

- fixed server version ([dcea65a](https://github.com/brentbahry/server/commit/dcea65a231c894ff7872f48b9b6d36b44d28b72e))

## [1.0.6](https://github.com/brentbahry/server/compare/@proteinjs/server@1.0.5...@proteinjs/server@1.0.6) (2024-04-19)

**Note:** Version bump only for package @proteinjs/server

## [1.0.5](https://github.com/brentbahry/server/compare/@proteinjs/server@1.0.4...@proteinjs/server@1.0.5) (2024-04-19)

**Note:** Version bump only for package @proteinjs/server

## [1.0.4](https://github.com/brentbahry/server/compare/@proteinjs/server@1.0.3...@proteinjs/server@1.0.4) (2024-04-19)

**Note:** Version bump only for package @proteinjs/server

## [1.0.3](https://github.com/brentbahry/server/compare/@proteinjs/server@1.0.2...@proteinjs/server@1.0.3) (2024-04-19)

**Note:** Version bump only for package @proteinjs/server

## [1.0.2](https://github.com/brentbahry/server/compare/@proteinjs/server@1.0.1...@proteinjs/server@1.0.2) (2024-04-19)

### Bug Fixes

- [server] added dep (was devDep) @pmmmwh/react-refresh-webpack-plugin ([49479d1](https://github.com/brentbahry/server/commit/49479d1b23e0d767bb0d00731002a2bf77ede892))

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/server
