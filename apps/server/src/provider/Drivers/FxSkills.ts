/**
 * Discover fx skills for the `$` picker by scanning SKILL.md directories.
 *
 * fx has no skills CLI. Roots are workspace nearest-first, then user roots.
 * When two skills share a name, the first root in that order wins. fx's docs
 * do not define precedence; this is that choice.
 *
 * @module provider/Drivers/FxSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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

export class FxSkillsProbeError extends Schema.TaggedError<FxSkillsProbeError>()("FxSkillsProbeError", {
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `fx could not read skills at '${this.path}'.`;
  }
}

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

const readDirectoryIfPresent = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readDirectory(directory).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<ReadonlyArray<string>>([])
            : Effect.fail(new FxSkillsProbeError({ path: directory, cause: error })),
      }),
    );
  });

const readSkillFileIfPresent = (skillPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(skillPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail(new FxSkillsProbeError({ path: skillPath, cause: error })),
      }),
    );
    if (info === undefined || info.type !== "File" || info.size > MAX_SKILL_BYTES) {
      return undefined;
    }
    return yield* fileSystem.readFileString(skillPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail(new FxSkillsProbeError({ path: skillPath, cause: error })),
      }),
    );
  });

const discoverSkillsInRoot = Effect.fn("discoverFxSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "project" | "user";
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  FxSkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const entries = yield* readDirectoryIfPresent(input.directory);
  const skills: Array<ServerProviderSkill> = [];
  for (const entry of entries) {
    const directoryName = entry.trim();
    if (!directoryName) {
      continue;
    }
    const skillPath = path.join(input.directory, directoryName, "SKILL.md");
    const contents = yield* readSkillFileIfPresent(skillPath);
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
}): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  FxSkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
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
