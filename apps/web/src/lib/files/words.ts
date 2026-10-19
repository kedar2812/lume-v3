const TYPE_WORD: Record<string, string> = {
  "application/pdf": "PDF",
  "text/plain": "Text",
  "image/jpeg": "Photo",
  "image/png": "Photo",
};

/** What a file is, in a word: "PDF", "Photo", "DOCX" (from its name), "Video", or "File". */
export const fileTypeWord = (f: { mime: string; kind: string; name: string | null }) =>
  TYPE_WORD[f.mime] ?? f.name?.split(".").pop()?.toUpperCase() ?? (f.kind === "video" ? "Video" : "File");
