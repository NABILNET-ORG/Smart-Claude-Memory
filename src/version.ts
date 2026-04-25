// Single source of truth for the package version.
//
// All runtime version reporting (MCP server registration, check_system_health,
// delegate_task synthesis envelope) MUST import VERSION from here so the value
// stays in lock-step with package.json. Hard-coded literals are forbidden —
// they drift silently and make health reports lie.
//
// Mechanism: createRequire is the safest cross-Node, NodeNext-friendly way to
// load a JSON file from an ESM module. tsconfig has resolveJsonModule + the
// `import ... with { type: "json" }` form would also work, but createRequire
// avoids loader-flag friction across Node versions.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
