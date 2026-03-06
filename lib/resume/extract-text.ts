import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_EXTRACTED_TEXT_LENGTH = 120_000;
let pdfWorkerConfigured = false;

function configurePdfWorkerForNode() {
  if (pdfWorkerConfigured) {
    return;
  }

  const workerCandidates = [
    path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.join(
      process.cwd(),
      "node_modules/pdf-parse/dist/pdf-parse/esm/pdf.worker.mjs",
    ),
  ];

  for (const workerPath of workerCandidates) {
    if (existsSync(workerPath)) {
      PDFParse.setWorker(pathToFileURL(workerPath).toString());
      pdfWorkerConfigured = true;
      return;
    }
  }
}

function cleanupText(value: string) {
  return value
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractResumeText(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
) {
  const lowerName = fileName.toLowerCase();
  const type = (mimeType ?? "").toLowerCase();

  let rawText = "";

  if (type.includes("pdf") || lowerName.endsWith(".pdf")) {
    configurePdfWorkerForNode();
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      rawText = parsed.text ?? "";
    } finally {
      await parser.destroy();
    }
  } else if (
    type.includes("wordprocessingml") ||
    type.includes("msword") ||
    lowerName.endsWith(".docx")
  ) {
    const parsed = await mammoth.extractRawText({ buffer });
    rawText = parsed.value ?? "";
  } else {
    throw new Error("Only PDF and DOCX files are supported");
  }

  const cleaned = cleanupText(rawText);

  if (!cleaned) {
    throw new Error("Unable to extract text from the uploaded resume");
  }

  return cleaned.slice(0, MAX_EXTRACTED_TEXT_LENGTH);
}
