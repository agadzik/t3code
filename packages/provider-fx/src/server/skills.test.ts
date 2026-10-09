import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverFxSkills } from "./skills.ts";

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

it.layer(NodeServices.layer)("discoverFxSkills", (it) => {
  it.effect("finds workspace and user skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      yield* writeSkill(
        path.join(workspace, ".fx", "skills"),
        "review",
        ["---", "name: review", "description: Review the diff.", "---", "", "# Review"].join("\n"),
      );
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: { HOME: home },
      });

      expect(skills).toEqual([
        {
          name: "review",
          path: path.join(workspace, ".fx", "skills", "review", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Review the diff.",
        },
        {
          name: "deploy",
          path: path.join(home, ".fx", "skills", "deploy", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Deploy the app.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops the upward walk before HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      yield* writeSkill(
        path.join(home, "skills"),
        "home-workspace-skill",
        ["---", "name: home-workspace-skill", "description: Should not load.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "user-skill",
        ["---", "name: user-skill", "description: User skill.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: { HOME: home },
      });

      expect(skills.map((skill) => skill.name)).toEqual(["user-skill"]);
      expect(skills[0]?.scope).toBe("user");
    }).pipe(Effect.scoped),
  );

  it.effect("uses the header name over the directory name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "directory-name",
        ["---", "name: header-name", "description: Named in YAML.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({ environment: { HOME: home } });

      expect(skills).toEqual([
        {
          name: "header-name",
          path: path.join(home, ".fx", "skills", "directory-name", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Named in YAML.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the directory name when SKILL.md has no header", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      yield* writeSkill(path.join(home, ".fx", "skills"), "plain-skill", "# No frontmatter\n");

      const skills = yield* discoverFxSkills({ environment: { HOME: home } });

      expect(skills).toEqual([
        {
          name: "plain-skill",
          path: path.join(home, ".fx", "skills", "plain-skill", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads a skill whose directory name has surrounding spaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      yield* writeSkill(path.join(home, ".fx", "skills"), "spaced-skill ", "# No frontmatter\n");

      const skills = yield* discoverFxSkills({ environment: { HOME: home } });

      expect(skills).toEqual([
        {
          name: "spaced-skill",
          path: path.join(home, ".fx", "skills", "spaced-skill ", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the nearer skill when names collide", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      yield* writeSkill(
        path.join(workspace, ".fx", "skills"),
        "shared",
        ["---", "name: shared", "description: Workspace copy.", "---"].join("\n"),
      );
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "shared",
        ["---", "name: shared", "description: User copy.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: { HOME: home },
      });

      expect(skills).toEqual([
        {
          name: "shared",
          path: path.join(workspace, ".fx", "skills", "shared", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Workspace copy.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a missing root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      yield* fs.makeDirectory(workspace, { recursive: true });

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: { HOME: home },
      });

      expect(skills).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores stray files in a skills root and still lists real skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const skillsRoot = path.join(home, ".fx", "skills");
      yield* fs.makeDirectory(skillsRoot, { recursive: true });
      yield* fs.writeFileString(path.join(skillsRoot, ".DS_Store"), "not a skill");
      yield* fs.writeFileString(path.join(skillsRoot, "README.md"), "# skills");
      yield* writeSkill(
        skillsRoot,
        "review",
        ["---", "name: review", "description: Review the diff.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({ environment: { HOME: home } });

      expect(skills.map((skill) => skill.name)).toEqual(["review"]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a workspace skills path that is a file and still lists user skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(home, "project");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(path.join(workspace, "skills"), "not a directory");
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({
        cwd: workspace,
        environment: { HOME: home },
      });

      expect(skills.map((skill) => skill.name)).toEqual(["deploy"]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a skill directory without SKILL.md", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fx-skills-" });
      const home = path.join(tempDir, "home");
      yield* fs.makeDirectory(path.join(home, ".fx", "skills", "empty"), { recursive: true });
      yield* writeSkill(
        path.join(home, ".fx", "skills"),
        "review",
        ["---", "name: review", "description: Review the diff.", "---"].join("\n"),
      );

      const skills = yield* discoverFxSkills({ environment: { HOME: home } });

      expect(skills.map((skill) => skill.name)).toEqual(["review"]);
    }).pipe(Effect.scoped),
  );
});
