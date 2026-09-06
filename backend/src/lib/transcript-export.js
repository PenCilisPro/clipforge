import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

/**
 * Transcript export — turns projects.transcript_json into downloadable
 * Markdown / PDF / DOCX files. Pure (no Supabase/Express) so it can be
 * unit-tested without any environment.
 *
 * Paragraphs are rebuilt from the word-level timings: a new paragraph starts
 * after a >= 3 s pause or ~60 words, and each carries an [m:ss] timestamp.
 */

const PARAGRAPH_GAP_SECONDS = 3;
const PARAGRAPH_MAX_WORDS = 60;

/** Group word-level timings into readable paragraphs. */
export function groupParagraphs(transcriptJson) {
  const words = Array.isArray(transcriptJson?.words) ? transcriptJson.words : [];
  const paragraphs = [];
  let current = null;

  const push = () => {
    if (current && current.text.trim()) paragraphs.push(current);
    current = null;
  };

  for (const w of words) {
    const start = Number(w.start);
    const end = Number(w.end);
    const text = String(w.word ?? "").trim();
    if (!Number.isFinite(start) || !text) continue;
    const gap = current ? start - current.end : 0;
    if (!current || gap >= PARAGRAPH_GAP_SECONDS || current.wordCount >= PARAGRAPH_MAX_WORDS) {
      push();
      current = { start, end, text, wordCount: 0 };
    } else {
      current.end = end;
      current.text += ` ${text}`;
    }
    current.wordCount += 1;
  }
  push();

  // Fallback: no word timings (shouldn't happen) — one big paragraph.
  if (paragraphs.length === 0 && transcriptJson?.transcript) {
    return [{ start: 0, end: 0, text: String(transcriptJson.transcript), wordCount: 0 }];
  }
  return paragraphs;
}

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function projectTitle(project) {
  return project?.title?.trim() || "Transcript";
}

/** Standard PDF fonts are WinAnsi — map curly punctuation, drop the rest. */
function pdfSafe(text) {
  return String(text)
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013]/g, "-")
    .replace(/[\u2014]/g, "—")
    .replace(/[\u2026]/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2026]/g, "");
}

function metaLine(project) {
  const parts = [];
  if (project?.created_at) {
    parts.push(new Date(project.created_at).toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
    }));
  }
  if (Number.isFinite(Number(project?.duration_seconds)) && Number(project.duration_seconds) > 0) {
    const s = Math.round(Number(project.duration_seconds));
    parts.push(`${Math.floor(s / 60)} min`);
  }
  return parts.join(" · ");
}

export function transcriptFilename(project, ext) {
  const slug =
    String(project?.title ?? "transcript")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "transcript";
  const date = new Date().toISOString().slice(0, 10);
  return `${slug}-${date}.${ext}`;
}

export function buildMarkdown(project) {
  const lines = [
    `# ${projectTitle(project)}`,
    "",
  ];
  const meta = metaLine(project);
  if (meta) lines.push(`_${meta}_`, "");
  for (const p of groupParagraphs(project?.transcript_json)) {
    lines.push(`**[${formatTimestamp(p.start)}]** ${p.text}`, "");
  }
  return lines.join("\n");
}

export async function buildPdf(project) {
  const doc = new PDFDocument({ margin: 72, size: "A4", info: { Title: projectTitle(project) } });
  const chunks = [];
  const done = new Promise((resolve) => doc.on("end", resolve));
  doc.on("data", (chunk) => chunks.push(chunk));

  doc.fontSize(20).text(pdfSafe(projectTitle(project)), { paragraphGap: 6 });
  const meta = metaLine(project);
  if (meta) {
    doc.fontSize(10).fillColor("#666666").text(pdfSafe(meta));
    doc.fillColor("#000000");
  }
  doc.moveDown(1);

  for (const p of groupParagraphs(project?.transcript_json)) {
    doc
      .fontSize(11)
      .fillColor("#FF5D1C")
      .text(`[${formatTimestamp(p.start)}] `, { continued: true, lineGap: 3 })
      .fillColor("#000000")
      .text(pdfSafe(p.text), { paragraphGap: 10, lineGap: 3 });
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

export async function buildDocx(project) {
  const children = [
    new Paragraph({ text: projectTitle(project), heading: HeadingLevel.HEADING_1 }),
  ];
  const meta = metaLine(project);
  if (meta) {
    children.push(new Paragraph({ children: [new TextRun({ text: meta, italics: true, color: "666666" })] }));
  }
  for (const p of groupParagraphs(project?.transcript_json)) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `[${formatTimestamp(p.start)}] `, bold: true, color: "FF5D1C" }),
          new TextRun({ text: p.text }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
