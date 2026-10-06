/**
 * Discover fx skills for the `$` picker by scanning SKILL.md directories.
 *
 * fx has no skills CLI. Roots are workspace nearest-first, then user roots.
 * When two skills share a name, the first root in that order wins. fx's docs
 * do not define precedence; this is that choice. One bad root or entry is
 * skipped so it cannot empty the catalog.
 *
 * @module provider/Drivers/FxSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_BYTES = 1_000_000;

const WORKSPACE_SKILL_RELATIVE_ROOTS = [
  ".fx/skills",
  "skills",
  ".opencode/skills",
  ".codex/skills",
  ".claude/skills",
  ".agents/skills",
  ".claw/skills",
] as const;

const USER_SKILL_RELATIVE_ROOTS = [
  ".fx/skills",
  ".config/opencode/skills",
  ".codex/skills",
  ".claude/skills",
  ".agents/skills",
  ".claw/skills",
] as const;

function parseFxSkillFrontmatter(contents: string): {
  readonly name?: string;
  readonly description?: string;
} {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return {};
  }
  try {
    const parsed = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  } catch {
    return {};
  }
}

function resolveFxUserHome(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME?.trim();
  return home && home.length > 0 ? home : NodeOS.homedir();
}

function workspaceSkillDirectories(
  path: Path.Path,
  workspaceCwd: string,
  home: string,
): ReadonlyArray<string> {
  const directories: Array<string> = [];
  const homePath = path.resolve(home);
  let current = path.resolve(workspaceCwd);
  while (current !== homePath) {
    for (const relative of WORKSPACE_SKILL_RELATIVE_ROOTS) {
      directories.push(path.join(current, relative));
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return directories;
}

function userSkillDirectories(path: Path.Path, home: string): ReadonlyArray<string> {
  return USER_SKILL_RELATIVE_ROOTS.map((relative) => path.join(home, relative));
}

const skipPath = <A, R>(
  path: string,
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.logWarning("fx skill scan skipped a path", { path }).pipe(Effect.as(undefined)),
    }),
  );

const discoverSkillsInRoot = Effect.fn("discoverFxSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "project" | "user";
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootInfo = yield* skipPath(input.directory, fileSystem.stat(input.directory));
  if (rootInfo?.type !== "Directory") {
    return [];
  }
  const entries = yield* skipPath(input.directory, fileSystem.readDirectory(input.directory));
  if (entries === undefined) {
    return [];
  }
  const skills: Array<ServerProviderSkill> = [];
  for (const entry of entries) {
    const directoryName = entry.trim();
    if (!directoryName) {
      continue;
    }
    const candidate = path.join(input.directory, directoryName);
    const candidateInfo = yield* skipPath(candidate, fileSystem.stat(candidate));
    if (candidateInfo?.type !== "Directory") {
      continue;
    }
    const skillPath = path.join(candidate, "SKILL.md");
    const skillInfo = yield* skipPath(skillPath, fileSystem.stat(skillPath));
    if (skillInfo?.type !== "File" || skillInfo.size > MAX_SKILL_BYTES) {
      continue;
    }
    const contents = yield* skipPath(skillPath, fileSystem.readFileString(skillPath));
    if (contents === undefined) {
      continue;
    }
    const frontmatter = parseFxSkillFrontmatter(contents);
    const name = frontmatter.name ?? directoryName;
    skills.push({
      name,
      path: skillPath,
      scope: input.scope,
      enabled: true,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
    });
  }
  return skills;
});

export const discoverFxSkills = Effect.fn("discoverFxSkills")(function* (input: {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const environment = input.environment ?? process.env;
  const home = path.resolve(resolveFxUserHome(environment));
  const roots: Array<{ directory: string; scope: "project" | "user" }> = [
    ...(input.cwd === undefined
      ? []
      : workspaceSkillDirectories(path, input.cwd, home).map((directory) => ({
          directory,
          scope: "project" as const,
        }))),
    ...userSkillDirectories(path, home).map((directory) => ({
      directory,
      scope: "user" as const,
    })),
  ];
  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const skills = yield* discoverSkillsInRoot(root);
    for (const skill of skills) {
      if (!skillsByName.has(skill.name)) {
        skillsByName.set(skill.name, skill);
      }
    }
  }
  return [...skillsByName.values()];
});
