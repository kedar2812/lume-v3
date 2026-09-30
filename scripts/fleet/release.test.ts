import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const MARKER = path.join(ROOT, "infra/docker/release-marker.sh");

describe("the release marker (L-C Task 1)", () => {
  it("LUME_RELEASE=1 writes /app/release.json with the version; anything else writes nothing", () => {
    const rel = mkdtempSync(path.join(tmpdir(), "rel-"));
    execFileSync("sh", [MARKER, "1", "1.4.2", rel]);
    expect(JSON.parse(readFileSync(path.join(rel, "release.json"), "utf8"))).toEqual({
      release: true,
      version: "1.4.2",
    });
    const dev = mkdtempSync(path.join(tmpdir(), "dev-"));
    execFileSync("sh", [MARKER, "", "dev", dev]);
    expect(existsSync(path.join(dev, "release.json"))).toBe(false);
  });
  it("a release needs a real version", () => {
    const rel = mkdtempSync(path.join(tmpdir(), "rel-"));
    expect(() => execFileSync("sh", [MARKER, "1", "", rel], { stdio: "pipe" })).toThrow();
    expect(() => execFileSync("sh", [MARKER, "1", "latest", rel], { stdio: "pipe" })).toThrow();
  });
  it("every LUME image runs the marker, and passes on its version", () => {
    for (const name of ["api", "web", "worker"]) {
      const d = read(`infra/docker/${name}.Dockerfile`);
      expect(d, name).toMatch(/ARG LUME_RELEASE/);
      // No default: a dev image has none, so it reports LUME's own version (appVersion's fallback).
      expect(d, name).toMatch(/^ARG LUME_VERSION$/m);
      expect(d, name).toMatch(/release-marker\.sh "\$LUME_RELEASE" "\$LUME_VERSION" \/app/);
      expect(d, name).toMatch(/ENV LUME_VERSION=\$LUME_VERSION/);
    }
  });
});

describe("the release workflow", () => {
  const wf = () => read(".github/workflows/release.yml");
  it("runs on a vX.Y.Z tag and builds the four images as releases", () => {
    expect(wf()).toMatch(/tags:\s*\[\s*"v\*\.\*\.\*"\s*\]/);
    expect(wf()).toMatch(/image: \[api, web, worker, caddy\]/);
    expect(wf()).toContain("file: infra/docker/${{ matrix.image }}.Dockerfile");
    expect(wf()).toMatch(/LUME_RELEASE=1/);
    expect(wf()).toMatch(/LUME_VERSION=\$\{\{ steps\.v\.outputs\.version \}\}/);
  });
  it("tags each image by its version in GHCR, as the compose file names it, and never latest", () => {
    // The names a client's compose file builds: ${LUME_IMAGE_PREFIX}/<image>:${LUME_TAG}.
    expect(wf()).toContain(
      "tags: ghcr.io/${{ github.repository }}/${{ matrix.image }}:${{ steps.v.outputs.version }}",
    );
    expect(wf()).not.toMatch(/:latest/);
  });
  it("refuses a tag that doesn't match package.json's version", () => {
    expect(wf()).toMatch(/package\.json/);
    expect(wf()).toMatch(/exit 1/);
  });
});

describe("the version", () => {
  it("package.json's version is CHANGELOG.md's newest entry", () => {
    const version = (JSON.parse(read("package.json")) as { version?: string }).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const newest = /^## (\d+\.\d+\.\d+)/m.exec(read("CHANGELOG.md"))?.[1];
    expect(newest).toBe(version);
  });
  it("the changelog says that 0030 widened existing roles (Sales can run send queues)", () => {
    expect(read("CHANGELOG.md")).toMatch(/0030[\s\S]*messages\.send_queue/);
  });
});
