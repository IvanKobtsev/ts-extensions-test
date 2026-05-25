# ts-extension-methods

> **TypeScript extension methods** — write C#-style extension methods on any type, with full IDE support: autocompletion, hover tooltips, go-to-definition, signature help, and semantic highlighting.

The package ships two independent pieces:

| Export                             | Purpose                                                    |
|------------------------------------|------------------------------------------------------------|
| `ts-extension-methods` (default)   | **TypeScript Language Service plugin** — IDE intelligence  |
| `ts-extension-methods/vite-plugin` | **Vite plugin** — runtime code transform                   |

---

## How it works

You define extension methods in files named `*.ext.ts`:

```ts
// src/user.ext.ts
import type { User } from "./types";

export type Admin = { id: string; name: string; role: string };

export function toAdmin(user: User): Admin {
    return { id: user.id, name: user.name, role: "admin" };
}
```

The first parameter of every exported function becomes the implicit receiver — just like `this` in a method. Then in your regular files you import the `.ext` file as a side effect and call the methods directly on the value:

```ts
// src/main.ts
import type { User } from "./types";
import "./user.ext";           // side-effect import enables the extension methods

const user: User = { id: "1", name: "Alice", surname: "Smith" };

const admin = user.toAdmin(); // ✅  IDE shows full type information
```

The **Vite plugin** rewrites the call to a plain function call at build time, so the generated output is:

```js
import { toAdmin } from "./user.ext";
const admin = toAdmin(user);  // runtime output
```

---

## Installation

```bash
npm install -D ts-extension-methods
```

---

## Setup

### 1 — TypeScript Language Service plugin (IDE support)

Add the plugin to your `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "plugins": [
      { "name": "ts-extension-methods" }
    ]
  }
}
```

> **IDE note**: VS Code uses its own bundled TypeScript version by default. Switch to the workspace TypeScript version (**"TypeScript: Select TypeScript Version…"** → **"Use Workspace Version"**) so the plugin is picked up. JetBrains IDEs (WebStorm, IntelliJ) use the project's TypeScript automatically.

### 2 — Vite plugin (build-time transform)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { tsExtensionsPlugin } from "ts-extension-methods/vite-plugin";

export default defineConfig({
    plugins: [tsExtensionsPlugin()],
});
```

---

## Writing extension methods

### Rules

1. File must be named `*.ext.ts` (e.g. `user.ext.ts`, `string.ext.ts`).
2. Every exported function whose **first parameter** is a typed value becomes an extension method on that type.
3. The function must be exported so the Vite plugin can resolve its name.

### `function` declaration style

```ts
// src/user.ext.ts
import type { User } from "./types";

export function greet(user: User): string {
    return `Hello, ${user.name}!`;
}
```

### Arrow function / `const` style

```ts
// src/user.ext.ts
import type { User } from "./types";

export const greet = (user: User): string => `Hello, ${user.name}!`;
```

### Multiple params

Additional parameters after the first one become the regular arguments of the call:

```ts
export function rename(user: User, newName: string): User {
    return { ...user, name: newName };
}

// usage:
user.rename("Bob");
```

### Chained calls

```ts
const renamed = user.rename("Bob").toAdmin();
```

---

## IDE features

| Feature                                    | Supported |
|--------------------------------------------|-----------|
| Autocompletion (dot-access)                | ✅         |
| Hover tooltip (extension method signature) | ✅         |
| Go to definition (`Ctrl+Click`)            | ✅         |
| Signature help (parameter hints)           | ✅         |
| Semantic token coloring (function color)   | ✅         |
| Error suppression for valid ext calls      | ✅         |
| "Not imported" error + quick fix           | ✅         |
| Duplicate extension method detection       | ✅         |
| "Find references" / "Find usages"          | ✅         |

---

## Limitations & known issues

- Module augmentation (for IDE return-type inference) only works when the receiver type is declared as an `interface`, not a `type` alias. Extension methods on `type` aliases are still callable and transformed correctly at runtime; they just won't be visible in the hover tooltip's type chain.
- The TypeScript Language Service plugin does **not** affect `tsc` compilation output — only IDE tooling. The Vite plugin is required for the runtime transform.
- The plugin is still in early development and may have edge cases. Contributions and bug reports are welcome!

---

## License

MIT © Ivan Kobtsev

