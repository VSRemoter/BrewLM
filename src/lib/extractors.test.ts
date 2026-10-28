import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { extractFileText } from "./extractors";

/** A .docx whose directory claims its text unpacks to `claimed` bytes. */
function docx(claimed?: number): File {
  const zip = zipSync({ "word/document.xml": strToU8("<w:document><w:body/></w:document>") });
  if (claimed !== undefined) {
    // Central directory entry (PK\1\2): uncompressed size at offset 24.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = 0; i < zip.length - 4; i++)
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, claimed, true);
  }
  return new File([zip], "bomb.docx");
}

describe("zip bombs", () => {
  it("refuses an office file that would unpack to more than 300 MB", async () => {
    await expect(extractFileText(docx(400 * 1024 * 1024))).rejects.toThrow(/300 MB/);
  });
});
