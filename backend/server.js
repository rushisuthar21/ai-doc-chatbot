import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import dotenv from "dotenv";
import { createRequire } from "module";
import { HfInference } from "@huggingface/inference";

dotenv.config();

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const hf = new HfInference(process.env.HF_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());

let documentText = "";

// Upload config
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ✅ Upload
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;

    if (req.file.mimetype === "application/pdf") {
      const data = await pdfParse(fs.readFileSync(filePath));
      documentText = data.text;
    } else if (req.file.mimetype === "text/plain") {
      documentText = fs.readFileSync(filePath, "utf-8");
    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    fs.unlinkSync(filePath);

    res.json({ message: "Upload successful ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed ❌" });
  }
});

// ✅ ASK (HF AI + FIXED)
app.post("/ask", async (req, res) => {
  const { question } = req.body;

  if (!documentText) {
    return res.json({ answer: "No document uploaded yet." });
  }

  const q = question.toLowerCase();

  console.log("QUESTION:", q); // DEBUG

  // ✅ FIXED intent detection
  if (
    (q.includes("show") && q.includes("content")) ||
    (q.includes("what") && q.includes("document")) ||
    (q.includes("read") && q.includes("document"))
  ) {
    console.log("SHOWING DOCUMENT"); // DEBUG

    return res.json({
      answer:
        documentText.length > 3000
          ? documentText.substring(0, 3000) + "\n\n... (truncated)"
          : documentText,
    });
  }

  try {
    console.log("CALLING HF AI"); // DEBUG

    const result = await hf.questionAnswering({
      model: "deepset/roberta-base-squad2",
      inputs: {
        question: question,
        context: documentText,
      },
    });

    let answer = result.answer;

    if (!answer || answer.trim() === "") {
      answer =
        "I couldn't find a clear answer. Here's part of the document:\n\n" +
        documentText.substring(0, 500) +
        "...";
    }

    res.json({ answer });
  } catch (err) {
    console.error(err);

    res.json({
      answer:
        "AI error. Showing document preview:\n\n" +
        documentText.substring(0, 500),
    });
  }
});

app.listen(5000, () => {
  console.log("✅ Server running at http://localhost:5000");
});