import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import { createRequire } from "module";

dotenv.config();

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");

const app = express();

app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// Roughly 4 chars/token — keep combined documents comfortably inside context
// while leaving room for the question, history, and a generous answer.
const MAX_CONTEXT_CHARS = 100000;
// How many prior turns to forward to Gemini for follow-up memory.
const MAX_HISTORY_TURNS = 8;

// ---------------- STATE ----------------
// Multiple documents can be loaded at once. Each keeps its own raw text,
// paragraphs (for keyword search + context), and line count.
let documents = []; // { id, fileName, text, lines, words, paragraphs }

const upload = multer({
  dest: "uploads/",
});

// ---------------- HELPERS ----------------

function buildParagraphsAndLines(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // First, try real paragraph breaks (blank lines between paragraphs).
  let paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Many PDF extractors (including pdf-parse) emit one line per visual line
  // with NO blank lines between sections — a whole resume can come back as
  // a single "paragraph". That makes every keyword match return the entire
  // document. Detect that case and fall back to a sliding window over the
  // lines instead, so matches land on a focused, readable chunk.
  const avgParagraphLength = paragraphs.length
    ? text.length / paragraphs.length
    : Infinity;
  const paragraphsLookBroken = paragraphs.length <= 2 || avgParagraphLength > 500;

  if (paragraphsLookBroken && lines.length > 0) {
    const windowSize = 4; // lines per chunk
    const step = 2; // 50% overlap so a match near a window edge still gets context
    const windowed = [];

    for (let i = 0; i < lines.length; i += step) {
      const chunk = lines.slice(i, i + windowSize).join(" ").trim();
      if (chunk) windowed.push(chunk);
      if (i + windowSize >= lines.length) break;
    }

    paragraphs = windowed.length ? windowed : lines;
  }

  return { lines, paragraphs };
}

function combinedDocumentText() {
  return documents
    .map((d) => `[${d.fileName}]\n${d.text}`)
    .join("\n\n---\n\n");
}

function truncateForContext(text) {
  return text.length > MAX_CONTEXT_CHARS
    ? text.slice(0, MAX_CONTEXT_CHARS) + "\n\n[...truncated for length...]"
    : text;
}

const SHOW_ALL_PATTERNS = [
  /show\s+(me\s+)?all/i,
  /show\s+(me\s+)?everything/i,
  /display\s+(me\s+)?all/i,
  /display\s+(me\s+)?everything/i,
  /entire\s+(content|document|file|text)/i,
  /full\s+(content|document|text)/i,
  /whole\s+(content|document|text)/i,
  /all\s+the\s+content/i,
  /everything\s+in\s+(the\s+)?(document|file|text)/i,
  /read\s+(me\s+)?the\s+whole/i,
  /give\s+(me\s+)?(the\s+)?(full|entire|whole)/i,
];

function isShowAllRequest(question) {
  const q = question.toLowerCase().trim();
  return SHOW_ALL_PATTERNS.some((re) => re.test(q));
}

// Lightweight suffix-stripping stemmer — not linguistically perfect, but
// enough to match "living"/"live"/"lives", "emails"/"email", etc. so the
// keyword fallback isn't defeated by simple inflection differences.
function stem(word) {
  let w = word;
  if (w.length > 6 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

// Question words that don't literally appear in documents but map to
// concepts that do (e.g. a question about "email" should still match a
// paragraph that just contains an address, no word "email" required).
const SYNONYMS = {
  email: ["email", "mail", "contact"],
  mail: ["email", "mail", "contact"],
  contact: ["contact", "email", "phone", "mail"],
  phone: ["phone", "mobile", "cell", "contact", "number"],
  number: ["number", "phone", "mobile"],
  live: ["live", "living", "reside", "residing", "location", "address"],
  lives: ["live", "living", "reside", "residing", "location", "address"],
  address: ["address", "location", "live", "living"],
  located: ["located", "location", "live", "living", "address"],
  location: ["location", "live", "living", "address"],
  gpa: ["gpa", "cgpa", "grade", "score"],
  grade: ["grade", "gpa", "cgpa", "score"],
  study: ["study", "studying", "studied", "education", "degree"],
  education: ["education", "degree", "study", "studying", "college", "university"],
  degree: ["degree", "certificate", "bachelor", "diploma", "qualification", "education"],
  work: ["work", "working", "worked", "job", "role", "experience", "company"],
  job: ["job", "work", "role", "position", "experience"],
  company: ["company", "work", "worked", "employer"],
  skills: ["skills", "skill", "proficient", "experience", "technologies"],
  age: ["age", "born", "birth", "old"],
  // "name" intentionally has no "called" synonym — that previously caused
  // imperative phrasing like "Name some cities" to false-match unrelated
  // sentences containing "is called X".
  name: ["name", "named"],
};

// Boost detectors: some answers are identifiable by shape (an email
// address, a phone number) regardless of the exact words used to ask.
const PATTERN_DETECTORS = [
  {
    triggers: ["email", "mail", "contact"],
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    boost: 60,
  },
  {
    triggers: ["phone", "number", "mobile", "cell", "contact"],
    regex: /(\+?\d[\d\-\s().]{7,}\d)/,
    boost: 60,
  },
  {
    triggers: ["gpa", "grade", "cgpa", "score"],
    regex: /\b(gpa|cgpa)\b/i,
    boost: 40,
  },
];

function expandKeywords(rawKeywords) {
  const expanded = new Set();
  rawKeywords.forEach((word) => {
    expanded.add(word);
    expanded.add(stem(word));
    (SYNONYMS[word] || []).forEach((syn) => {
      expanded.add(syn);
      expanded.add(stem(syn));
    });
  });
  return Array.from(expanded).filter((w) => w.length > 1);
}

function keywordRegex(word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Prefix match on the stemmed form so "living" matches a "live" stem
  // and vice versa, without needing a full morphological analyzer.
  return new RegExp(`\\b${escaped}\\w*`, "g");
}

// A word that shows up in almost every paragraph (like the subject's own
// name, repeated on every line of a resume) carries little information
// about *which* paragraph answers the question. Weight each keyword
// inversely to how many paragraphs in the whole corpus contain it, so a
// rare, specific word (e.g. "living") outweighs a common one (e.g. a name).
function buildKeywordWeights(keywords, allParagraphsLower) {
  const weights = {};
  keywords.forEach((word) => {
    const re = keywordRegex(word);
    let paragraphsContaining = 0;
    for (const p of allParagraphsLower) {
      re.lastIndex = 0;
      if (re.test(p)) paragraphsContaining++;
    }
    // 1 paragraph match -> full weight; common words decay toward a floor.
    weights[word] = paragraphsContaining <= 1 ? 10 : Math.max(2, 10 / paragraphsContaining);
  });
  return weights;
}

function scoreParagraph(lowerParagraph, keywords, rawKeywords, weights) {
  let score = 0;

  keywords.forEach((word) => {
    const re = keywordRegex(word);
    const occurrences = (lowerParagraph.match(re) || []).length;
    if (occurrences > 0) {
      const weight = weights ? weights[word] ?? 10 : 10;
      // Cap repeated occurrences of the same word so it can't dominate
      // purely by appearing many times in one paragraph.
      score += Math.min(occurrences, 2) * weight;
    }
  });

  PATTERN_DETECTORS.forEach(({ triggers, regex, boost }) => {
    const questionWantsThis = rawKeywords.some((k) => triggers.includes(k));
    if (questionWantsThis && regex.test(lowerParagraph)) {
      score += boost;
    }
  });

  return score;
}

function findBestAnswer(question) {
  const q = question.toLowerCase();

  const stopWords = [
    "what", "which", "where", "who", "when", "why", "how",
    "is", "are", "was", "were", "the", "of", "a", "an",
    "in", "to", "for", "does", "do", "did", "tell", "me",
    "about", "please", "can", "you", "his", "her", "their",
    "he", "she", "they", "it", "its", "this", "that", "and",
    "with", "have", "has", "had", "give", "show",
    "know", "get", "from",
  ];

  const rawKeywords = q
    .replace(/[^\w\s@.-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, "")) // drop stray leading/trailing punctuation (e.g. sentence-final "canada.")
    .filter((word) => word.length > 2 && !stopWords.includes(word));

  if (rawKeywords.length === 0) {
    return { answer: "Could you rephrase that with a bit more detail?" };
  }

  const keywords = expandKeywords(rawKeywords);

  // Precompute rarity weights across every paragraph in every document,
  // so common words (like a name repeated throughout a resume) don't
  // drown out the one distinctive word that actually points to the answer.
  const allParagraphsLower = documents.flatMap((doc) =>
    doc.paragraphs.map((p) => p.toLowerCase())
  );
  const weights = buildKeywordWeights(keywords, allParagraphsLower);

  // Step 1: score each document as a whole, so a name or word that appears
  // in two different files doesn't cause us to pull a paragraph from the
  // wrong one — we first decide *which file* actually answers this.
  let docScores = documents.map((doc) => {
    const total = doc.paragraphs.reduce(
      (sum, p) => sum + scoreParagraph(p.toLowerCase(), keywords, rawKeywords, weights),
      0
    );
    return { doc, total };
  });

  docScores.sort((a, b) => b.total - a.total);
  const topDoc = docScores[0];

  if (!topDoc || topDoc.total === 0) {
    return {
      answer:
        "I don't see anything about that in the uploaded document(s) — it may not be covered, or try rephrasing the question.",
    };
  }

  // Step 2: within the winning document, find the single best-matching
  // paragraph/chunk to actually answer from.
  let bestParagraph = "";
  let bestScore = 0;
  for (const paragraph of topDoc.doc.paragraphs) {
    const lowerParagraph = paragraph.toLowerCase();
    const score = scoreParagraph(lowerParagraph, keywords, rawKeywords, weights);
    if (score > bestScore) {
      bestScore = score;
      bestParagraph = paragraph;
    }
  }

  // Confidence floor: don't answer on the strength of one common word
  // matching by coincidence (e.g. "capital" alone matching three unrelated
  // sentences when asked about France). Group matched keywords back to the
  // *original* question word they came from (so "living" and "based on"
  // matching from the single word "live" only count once), then require
  // either two distinct question-words to corroborate each other, one very
  // rare/specific single match, or a pattern-detector hit (email/phone/GPA).
  const bestLower = bestParagraph.toLowerCase();
  let matchedGroups = 0;
  let bestGroupWeight = 0;
  rawKeywords.forEach((rawWord) => {
    const group = Array.from(
      new Set([rawWord, stem(rawWord), ...(SYNONYMS[rawWord] || [])])
    );
    const groupWeight = Math.max(
      0,
      ...group.map((w) => (keywordRegex(w).test(bestLower) ? weights[w] ?? 0 : 0))
    );
    if (groupWeight > 0) {
      matchedGroups++;
      bestGroupWeight = Math.max(bestGroupWeight, groupWeight);
    }
  });
  const hasPatternHit = PATTERN_DETECTORS.some(({ triggers, regex }) => {
    const questionWantsThis = rawKeywords.some((k) => triggers.includes(k));
    return questionWantsThis && regex.test(bestLower);
  });
  const isConfident = matchedGroups >= 2 || bestGroupWeight >= 4.5 || hasPatternHit;

  if (!bestParagraph || !isConfident) {
    return {
      answer:
        "I don't see anything about that in the uploaded document(s) — it may not be covered, or try rephrasing the question.",
    };
  }

  const prefix = documents.length > 1 ? `[${topDoc.doc.fileName}] ` : "";
  return { answer: prefix + bestParagraph };
}

// ---------------- AI-POWERED ANSWERS (free Gemini API) ----------------

async function callGemini({ systemText, contents, generationConfig }) {
  if (!GEMINI_API_KEY) return null;

  const body = { contents };
  if (systemText) {
    body.system_instruction = { parts: [{ text: systemText }] };
  }
  if (generationConfig) {
    body.generationConfig = generationConfig;
  }

  const response = await axios.post(GEMINI_URL, body, {
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "content-type": "application/json",
    },
    timeout: 25000,
  });

  const text = response.data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .join("")
    .trim();

  return text || null;
}

async function askGemini(question, history) {
  const context = truncateForContext(combinedDocumentText());

  const systemText =
    "You are an expert assistant that answers questions strictly and only from the " +
    "document text provided below. Never use outside knowledge, never guess, and never " +
    "fill in facts the documents don't actually contain — even if the answer seems obvious " +
    "or you happen to know it from general knowledge.\n\n" +
    "How to read the question:\n" +
    "- Understand intent, not just literal words. A question about where someone \"lives\" " +
    "should match text about them \"residing\", \"based in\", or \"currently in\" a place. " +
    "\"Email\" should match a bare email address even if the word \"email\" never appears. " +
    "Treat singular/plural, verb tense, and close synonyms as the same thing.\n" +
    "- If the question is a follow-up (e.g. \"what about her phone number\"), use the " +
    "conversation history to resolve who/what it refers to.\n\n" +
    (documents.length > 1
      ? "Multiple documents are included below, each marked with its filename in [brackets]. " +
        "Figure out which document(s) actually contain the relevant information based on " +
        "their content — do not assume two files are related just because a name or word " +
        "happens to appear in both. If two documents mention the same name but are clearly " +
        "about different people or topics, only use the one whose surrounding content " +
        "actually matches the question. When you do answer from a specific file, say which " +
        "one naturally (e.g. \"According to resume.pdf, ...\"), but don't do this mechanically " +
        "for every single reply if it's obvious from context.\n\n"
      : "") +
    "How to answer:\n" +
    "- Sound like a knowledgeable, direct human, not a robotic text dump. It's fine to " +
    "lightly rephrase the relevant fact for clarity, but never change or embellish the " +
    "underlying facts.\n" +
    "- Be concise — a sentence or two is usually enough unless the user asks for more detail.\n" +
    "- If the documents genuinely don't contain the answer, say so plainly and naturally " +
    "(e.g. \"I don't see that in the uploaded documents\") rather than guessing.\n" +
    "- If the question has nothing to do with the documents at all (small talk, general " +
    "knowledge, unrelated coding help, etc.), politely explain you can only answer questions " +
    "about the uploaded documents.\n\n" +
    `Documents:\n"""\n${context}\n"""`;

  const contents = [
    ...history.map((h) => ({
      role: h.role === "user" ? "user" : "model",
      parts: [{ text: h.text }],
    })),
    { role: "user", parts: [{ text: question }] },
  ];

  return callGemini({
    systemText,
    contents,
    generationConfig: { temperature: 0.2 },
  });
}

async function summarizeDocument(text) {
  const truncated = truncateForContext(text);
  const contents = [
    {
      role: "user",
      parts: [
        {
          text:
            "Summarize the following document in 2-3 concise sentences, " +
            `capturing its main topic and key points.\n\n"""\n${truncated}\n"""`,
        },
      ],
    },
  ];
  return callGemini({ contents });
}

// ---------------- DOCUMENTS ----------------

app.get("/documents", (req, res) => {
  res.json({
    documents: documents.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      lines: d.lines,
      words: d.words,
    })),
  });
});

app.delete("/documents/:id", (req, res) => {
  const before = documents.length;
  documents = documents.filter((d) => d.id !== req.params.id);
  res.json({ success: true, removed: before !== documents.length });
});

app.delete("/documents", (req, res) => {
  documents = [];
  res.json({ success: true });
});

// ---------------- UPLOAD ----------------

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded.",
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const isPdf = req.file.mimetype === "application/pdf" || ext === ".pdf";

    let text = "";

    if (isPdf) {
      const parser = new PDFParse({ data: fs.readFileSync(req.file.path) });
      const result = await parser.getText();
      await parser.destroy();
      text = result.text;
    } else {
      text = fs.readFileSync(req.file.path, "utf8");
    }

    fs.unlinkSync(req.file.path);

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "That file didn't contain any readable text.",
      });
    }

    text = text.trim();
    const { lines, paragraphs } = buildParagraphsAndLines(text);
    const fileName = req.file.originalname;
    const words = text.split(/\s+/).filter(Boolean).length;
    const id = crypto.randomUUID();

    documents.push({ id, fileName, text, lines: lines.length, words, paragraphs });

    let summary = null;
    if (GEMINI_API_KEY) {
      try {
        summary = await summarizeDocument(text);
      } catch (err) {
        console.error("Summary generation failed:", err.response?.data || err.message);
      }
    }

    res.json({
      success: true,
      message: `✅ "${fileName}" uploaded successfully!`,
      id,
      fileName,
      lines: lines.length,
      words,
      summary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Upload failed. Please try a .txt or .pdf file.",
    });
  }
});

// ---------------- ASK ----------------

app.post("/ask", async (req, res) => {
  try {
    const { question, history } = req.body;

    if (!question || !question.trim()) {
      return res.json({ answer: "Please ask a question." });
    }

    if (documents.length === 0) {
      return res.json({
        answer: "Please upload a document first, then ask away!",
      });
    }

    if (isShowAllRequest(question)) {
      return res.json({
        answer: combinedDocumentText(),
        isFullContent: true,
      });
    }

    const trimmedHistory = Array.isArray(history)
      ? history.slice(-MAX_HISTORY_TURNS)
      : [];

    if (GEMINI_API_KEY) {
      try {
        const aiAnswer = await askGemini(question, trimmedHistory);
        if (aiAnswer) {
          return res.json({ answer: aiAnswer, source: "ai" });
        }
      } catch (err) {
        console.error(
          "Gemini API request failed, falling back to keyword search:",
          err.response?.data || err.message
        );
      }
    }

    const { answer } = findBestAnswer(question);
    res.json({ answer, source: "keyword" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ answer: "Server error" });
  }
});

// ---------------- STATUS ----------------

app.get("/status", (req, res) => {
  res.json({
    hasDocument: documents.length > 0,
    documentCount: documents.length,
    aiEnabled: Boolean(GEMINI_API_KEY),
  });
});

// ---------------- START ----------------

app.listen(5000, () => {
  console.log("Server running on http://localhost:5000");
});
