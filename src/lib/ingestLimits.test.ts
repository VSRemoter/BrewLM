import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ platform: {} }));
vi.mock("./settings", () => ({ loadSettings: vi.fn(async () => ({ keepRecordings: true })) }));
vi.mock("./db", () => ({ addSource: vi.fn() }));
vi.mock("./rag", () => ({ indexSource: vi.fn() }));
vi.mock("./media", () => ({ describeImage: vi.fn(), transcribeAudio: vi.fn(), TRANSCRIPT_ONLY: "" }));
vi.mock("./extractors", () => ({ extractFileText: vi.fn(), MAX_SOURCE_CHARS: 1 }));

import { addSource } from "./db";
import { ingestFiles, tooLargeToRead } from "./ingest";

const MB = 1024 * 1024;

/** A file that says it's `size` bytes without holding them. */
function bigFile(name: string, type: string, size: number): File {
  const f = new File([], name, { type });
  Object.defineProperty(f, "size", { value: size });
  const unread = () => {
    throw new Error("the file was read");
  };
  Object.defineProperty(f, "arrayBuffer", { value: unread });
  Object.defineProperty(f, "text", { value: unread });
  Object.defineProperty(f, "stream", { value: unread });
  Object.defineProperty(f, "slice", { value: unread });
  return f;
}

describe("tooLargeToRead", () => {
  it("lets files up to each limit through", () => {
    expect(tooLargeToRead("pdf", "a.pdf", 200 * MB)).toBeNull();
    expect(tooLargeToRead("file", "a.docx", 100 * MB)).toBeNull();
    expect(tooLargeToRead("image", "a.png", 50 * MB)).toBeNull();
  });

  it("refuses bigger ones and says why", () => {
    expect(tooLargeToRead("pdf", "big.pdf", 201 * MB)).toBe("big.pdf is 201 MB. PDFs can be up to 200 MB, so it wasn't added.");
    expect(tooLargeToRead("text", "log.txt", 1024 * 1024 * MB)).toBe(
      "log.txt is 1,048,576 MB. Documents can be up to 100 MB, so it wasn't added."
    );
  });

  it("never limits audio and video (they're read in pieces)", () => {
    expect(tooLargeToRead("audio", "lecture.mp4", 50_000 * MB)).toBeNull();
  });
});

describe("ingestFiles", () => {
  it("refuses a huge PDF and document without reading them", async () => {
    const res = await ingestFiles("nb", [
      bigFile("huge.pdf", "application/pdf", 1000 * 1024 * MB),
      bigFile("huge.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 500 * MB),
    ]);
    expect(res.added).toEqual([]);
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0]).toMatch(/^huge\.pdf is 1,024,000 MB\. PDFs can be up to 200 MB/);
    expect(res.errors[1]).toMatch(/^huge\.docx is 500 MB\. Documents can be up to 100 MB/);
    expect(addSource).not.toHaveBeenCalled();
  });
});
