import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ProjectType =
  | "flutter"
  | "dart"
  | "web-ts"
  | "web-js"
  | "python"
  | "rust"
  | "go"
  | "unknown";

export type ProjectDetection = {
  workspace: string;
  type: ProjectType;
  markers: string[];
  compiler_gate_command: { bin: string; args: string[] } | null;
};

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function fileIncludes(p: string, needle: string): Promise<boolean> {
  try {
    const content = await readFile(p, "utf8");
    return content.includes(needle);
  } catch {
    return false;
  }
}

/**
 * Detect the project's stack from filesystem markers. Used by refactor_guard
 * to pick the right compiler-gate command and by init_project to customize
 * the readiness report per stack.
 */
export async function detectProjectType(workspace: string): Promise<ProjectDetection> {
  const markers: string[] = [];

  const pubspec = join(workspace, "pubspec.yaml");
  const packageJson = join(workspace, "package.json");
  const tsconfig = join(workspace, "tsconfig.json");
  const pyproject = join(workspace, "pyproject.toml");
  const requirements = join(workspace, "requirements.txt");
  const cargoToml = join(workspace, "Cargo.toml");
  const goMod = join(workspace, "go.mod");

  const [hasPub, hasPkg, hasTs, hasPy, hasReq, hasCargo, hasGo] = await Promise.all([
    exists(pubspec), exists(packageJson), exists(tsconfig),
    exists(pyproject), exists(requirements), exists(cargoToml), exists(goMod),
  ]);

  if (hasPub) {
    markers.push("pubspec.yaml");
    // Treat any pubspec as Flutter unless it explicitly has no flutter dep.
    const isFlutter = await fileIncludes(pubspec, "flutter:");
    return {
      workspace,
      type: isFlutter ? "flutter" : "dart",
      markers,
      compiler_gate_command: { bin: isFlutter ? "flutter" : "dart", args: ["analyze"] },
    };
  }

  if (hasPkg) {
    markers.push("package.json");
    if (hasTs) {
      markers.push("tsconfig.json");
      return {
        workspace,
        type: "web-ts",
        markers,
        // npx to avoid requiring a global typescript install.
        compiler_gate_command: { bin: "npx", args: ["tsc", "--noEmit"] },
      };
    }
    return {
      workspace,
      type: "web-js",
      markers,
      // node --check is per-file, not project-wide. For a JS project the
      // pragmatic gate is 'npm run build' or a lint script. Default to
      // 'node --check <entry>' if we had one — otherwise no automatic gate.
      compiler_gate_command: null,
    };
  }

  if (hasPy || hasReq) {
    markers.push(hasPy ? "pyproject.toml" : "requirements.txt");
    return {
      workspace,
      type: "python",
      markers,
      // py_compile gives syntax check across a whole package cheaply.
      compiler_gate_command: { bin: "python", args: ["-m", "compileall", "-q", workspace] },
    };
  }

  if (hasCargo) {
    markers.push("Cargo.toml");
    return {
      workspace,
      type: "rust",
      markers,
      compiler_gate_command: { bin: "cargo", args: ["check"] },
    };
  }

  if (hasGo) {
    markers.push("go.mod");
    return {
      workspace,
      type: "go",
      markers,
      compiler_gate_command: { bin: "go", args: ["vet", "./..."] },
    };
  }

  return { workspace, type: "unknown", markers, compiler_gate_command: null };
}
