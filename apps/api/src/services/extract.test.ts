import { describe, expect, it } from "vitest";
import { chunkPages, extractText, isSupported, UnsupportedFileError } from "./extract";

describe("chunkPages", () => {
  it("keeps short documents in one chunk", () => {
    const c = chunkPages([{ page: 1, text: "Hello world.\n\nSecond paragraph." }]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ ordinal: 0, page: 1 });
    expect(c[0]!.content).toContain("Second paragraph.");
  });

  it("splits long text with overlap and tracks pages", () => {
    const para = (n: number) => `Paragraph ${n}. ` + "word ".repeat(80);
    const pages = [
      { page: 1, text: [1, 2, 3].map(para).join("\n\n") },
      { page: 2, text: [4, 5, 6].map(para).join("\n\n") },
    ];
    const c = chunkPages(pages, 900, 150);
    expect(c.length).toBeGreaterThan(2);
    expect(c.every((x) => x.content.length <= 1200)).toBe(true);
    expect(c.some((x) => x.page === 2)).toBe(true);
    // Overlap: each chunk after the first starts with text from the previous one.
    const tailWord = c[0]!.content.slice(-40).split(" ").at(-2)!;
    expect(c[1]!.content.slice(0, 200)).toContain(tailWord);
    expect(c.map((x) => x.ordinal)).toEqual(c.map((_, i) => i));
  });

  it("hard-splits a single enormous line", () => {
    const c = chunkPages([{ page: null, text: "x".repeat(5000) }], 1000, 100);
    expect(c.length).toBeGreaterThanOrEqual(5);
  });
});

describe("extractText", () => {
  it("reads text and strips html", async () => {
    expect((await extractText("a.md", Buffer.from("# Title\nbody")))[0]!.text).toContain("Title");
    const html = await extractText("a.html", Buffer.from("<p>Hi<script>x()</script></p><p>there</p>"));
    expect(html[0]!.text).not.toContain("script");
    expect(html[0]!.text).toContain("there");
  });

  it("rejects unsupported files", async () => {
    expect(isSupported("movie.mp4")).toBe(false);
    expect(isSupported("photo.png")).toBe(true);
    await expect(extractText("archive.zip", Buffer.from(""))).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});

describe("real file formats", () => {
  const fixture = async (n: string) => (await import("node:fs/promises")).readFile(new URL(`../../test/fixtures/${n}`, import.meta.url));

  it("extracts text per page from a PDF", async () => {
    const pages = await extractText("report.pdf", await fixture("report.pdf"));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ page: 1 });
    expect(pages[0]!.text).toContain("revenue grew 18 percent");
    expect(pages[1]!.text).toContain("12 engineers");
    const chunks = chunkPages(pages);
    expect(chunks[0]!.page).toBe(1);
  });

  it("extracts text from a Word document", async () => {
    const pages = await extractText("policy.docx", await fixture("policy.docx"));
    expect(pages[0]!.text).toContain("Economy class is required");
  });

  it("reads every sheet of an Excel workbook, including formula results", async () => {
    const pages = await extractText("budget.xlsx", await fixture("budget.xlsx"));
    expect(pages).toHaveLength(2);
    expect(pages[0]!.text).toContain("Sheet: Budget");
    expect(pages[0]!.text).toContain("Servers | 12000 | 13500");
    expect(pages[0]!.text).toContain("Total | 16000 | 17500");
    expect(pages[1]!.text).toContain("Northwind Hosting | ops@northwind.test");
  });

  it("reads text from an image with OCR", async () => {
    const pages = await extractText("receipt.png", await fixture("receipt.png"));
    expect(pages[0]!.text).toMatch(/Invoice number 58213/);
    expect(pages[0]!.text).toMatch(/4,750/);
  }, 60_000);

  it("reads scanned PDF pages with OCR", async () => {
    const pages = await extractText("scanned.pdf", await fixture("scanned.pdf"));
    expect(pages[0]!.page).toBe(1);
    expect(pages[0]!.text).toMatch(/Notice period is ninety days/i);
  }, 60_000);
});
