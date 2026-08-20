import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findLaTeXRoot, buildProjectZip } from "../src/core/zip";
import JSZip from "jszip";

function makeProject(structure: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbz-"));
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("findLaTeXRoot", () => {
  const DOC = "\\documentclass{article}\n\\begin{document}\n";
  const INPUT = "\\input{ch1}\n\\end{document}\n";

  it("prefers % !TEX root directive", () => {
    const dir = makeProject({
      "main.tex": DOC + INPUT,
      "ch1.tex": "x",
      "book.tex": "% !TEX root = book.tex\nx",
    });
    expect(findLaTeXRoot(dir)).toBe("book.tex");
  });

  it("falls back to main.tex", () => {
    const dir = makeProject({
      "main.tex": DOC + INPUT,
      "ch1.tex": "y",
      "ch2.tex": "z",
    });
    expect(findLaTeXRoot(dir)).toBe("main.tex");
  });

  it("returns the only tex file", () => {
    const dir = makeProject({ "single.tex": DOC + "x\n\\end{document}" });
    expect(findLaTeXRoot(dir)).toBe("single.tex");
  });

  it("ignores a lone tex file without documentclass/begin", () => {
    const dir = makeProject({ "section.tex": "just a fragment" });
    expect(findLaTeXRoot(dir)).toBeNull();
  });

  it("returns null when ambiguous", () => {
    const dir = makeProject({
      "a.tex": DOC + "x\n\\end{document}",
      "b.tex": DOC + "y\n\\end{document}",
    });
    expect(findLaTeXRoot(dir)).toBeNull();
  });

  it("returns null when no tex files", () => {
    const dir = makeProject({ "README.md": "x" });
    expect(findLaTeXRoot(dir)).toBeNull();
  });
});

describe("buildProjectZip", () => {
  it("zips tex, figures, bib; skips build artifacts", async () => {
    const dir = makeProject({
      "main.tex": "\\input{sections/intro}",
      "sections/intro.tex": "hello",
      "figures/plot.pdf": "pdf",
      "bib/refs.bib": "@article{x}",
      "main.aux": "garbage",
      "main.log": "garbage",
      ".git/HEAD": "ref",
    });
    const proj = await buildProjectZip(dir, "main.tex");
    const zip = await JSZip.loadAsync(proj.zipBytes);
    const names = Object.keys(zip.files);
    expect(names).toContain("main.tex");
    expect(names).toContain("sections/intro.tex");
    expect(names).toContain("figures/plot.pdf");
    expect(names).toContain("bib/refs.bib");
    expect(names).not.toContain("main.aux");
    expect(names).not.toContain("main.log");
    expect(names.some((n) => n.includes(".git"))).toBe(false);
    expect(proj.sizeBytes).toBe(proj.zipBytes.byteLength);
  });

  it("re-roots the archive when the root file lives in a subfolder", async () => {
    const dir = makeProject({
      "README.md": "not part of the project",
      "samples/math-paper/main.tex": "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}",
      "samples/math-paper/sections/intro.tex": "hello",
      "samples/math-paper/figures/plot.pdf": "pdf",
      "samples/math-paper/bib/refs.bib": "@article{x}",
    });
    const proj = await buildProjectZip(dir, "samples/math-paper/main.tex");
    expect(proj.rootFile).toBe("main.tex");
    const zip = await JSZip.loadAsync(proj.zipBytes);
    const names = Object.keys(zip.files);
    expect(names).toContain("main.tex");
    expect(names).toContain("sections/intro.tex");
    expect(names).toContain("figures/plot.pdf");
    expect(names).toContain("bib/refs.bib");
    expect(names.some((n) => n.startsWith("samples/"))).toBe(false);
    expect(names.some((n) => n.includes("README.md"))).toBe(false);
  });
});
