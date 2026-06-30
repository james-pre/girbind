# girbind

Convert GObject Introspection (GIR) files into Node.js addons

## Installation

```sh
npm install girbind
```

## Usage

Girbind can be used in a couple of different ways:

### 1. As an authoring tool. `girbind` can be used if you're authoring a package that implements bindings for a library.

#### CLI

Use `girbind --help` for the full set of commands.

```sh
npx girbind init # Scaffold CMakeLists.txt
npx girbind generate # Generate C++ addon, Typescript types, and JS exports
npx girbind build
```

#### API

```ts
import * as girbind from 'girbind';
```

### 2. As a consumer tool. `girbind` can be used to generate bindings without needing to install additional packages

#### CLI

```sh
npx girbind add ...
npx girbind build
```
