// @effect-diagnostics nodeBuiltinImport:off - the runner is a plain Node process that runs outside the Effect runtime.
import * as NodePath from "node:path";

import { ToolInputError } from "./types.ts";

/**
 * Resolve a model-supplied path against the tool root and refuse anything
 * that escapes it. Symlinks are not followed here; the root is a policy
 * boundary for the model, not a sandbox.
 */
export function resolveWithinRoot(rootDir: string, requested: string): string {
  const root = NodePath.resolve(rootDir);
  const resolved = NodePath.resolve(root, requested);
  const relative = NodePath.relative(root, resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new ToolInputError(`Path escapes the workspace root: ${requested}`);
  }
  return resolved;
}

/** Locale-independent ordering so tool output is identical on every host. */
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toRootRelative(rootDir: string, absolute: string): string {
  const relative = NodePath.relative(NodePath.resolve(rootDir), absolute);
  return relative === "" ? "." : relative.split(NodePath.sep).join("/");
}
