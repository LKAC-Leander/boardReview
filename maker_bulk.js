import { db } from "./firebase.js";
import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const QUIZ_COLLECTION = "quizzes";

// ---------- Utilities ----------
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

function normalizeWhitespace(str) {
  return (str ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanPageArtifacts(str) {
  return (str ?? "")
    .replace(/BLEPP TEST BANK 2025\s*[–-]\s*KID ASUNCION/gi, "")
    .replace(/\b\d+\s*\|\s*P\s*a\s*g\s*e\b/gi, "")
    .replace(/\b\d+\s*\|\s*Page\b/gi, "")
    .trim();
}

function normalizeForCompare(str) {
  return cleanPageArtifacts(str)
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/[–—-]/g, "-")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------- Firestore ----------
async function loadAllQuizzes() {
  const snap = await getDocs(collection(db, QUIZ_COLLECTION));
  const quizzes = [];
  snap.forEach((d) => quizzes.push(d.data()));
  quizzes.sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  );
  return quizzes;
}

async function saveQuiz(quiz) {
  quiz.updatedAt = Date.now();
  if (!quiz.createdAt) quiz.createdAt = quiz.updatedAt;
  await setDoc(doc(db, QUIZ_COLLECTION, quiz.id), quiz);
}

async function loadQuizById(id) {
  const snap = await getDoc(doc(db, QUIZ_COLLECTION, id));
  return snap.exists() ? snap.data() : null;
}

async function deleteQuizById(id) {
  await deleteDoc(doc(db, QUIZ_COLLECTION, id));
}

// ---------- Parsing ----------
function parseQuestionBlock(raw) {
  const text = cleanPageArtifacts(normalizeWhitespace(raw));

  // supports "1." or "Q1."
  const questionRegex = /(?:^|\n)Q?(\d+)\.\s*(.*?)(?=(?:\nQ?\d+\.\s)|$)/gs;
  const questions = [];
  let match;

  while ((match = questionRegex.exec(text)) !== null) {
    const number = Number(match[1]);
    const block = match[2].trim();

    // must contain at least one choice line like a) or A)
    if (!/\n[a-zA-Z]\)\s*/.test(block)) continue;

    const firstChoiceIndex = block.search(/\n[a-zA-Z]\)\s*/);
    if (firstChoiceIndex === -1) continue;

    let stem = block.slice(0, firstChoiceIndex).trim();
    const choicesPart = block.slice(firstChoiceIndex).trim();

    stem = cleanPageArtifacts(stem).replace(/\s+/g, " ").trim();

    // supports a) ... z)
    const choiceRegex = /([a-zA-Z])\)\s*(.*?)(?=(?:\n[a-zA-Z]\)\s*)|$)/gs;
    const choices = [];
    let cMatch;

    while ((cMatch = choiceRegex.exec(choicesPart)) !== null) {
      const letter = cMatch[1].toUpperCase();
      const choiceText = cleanPageArtifacts(cMatch[2]).replace(/\s+/g, " ").trim();
      if (choiceText) {
        choices.push({
          letter,
          text: choiceText
        });
      }
    }

    if (choices.length >= 2) {
      questions.push({
        number,
        text: stem,
        choices
      });
    }
  }

  return questions;
}

function parseAnswerKeyBlock(raw) {
  const text = cleanPageArtifacts(normalizeWhitespace(raw));
  const answers = new Map();

  // Format 1: "37. The answer is E. feedback..."
  const regex1 =
    /(?:^|\n)Q?(\d+)\.\s*The answer is\s+([A-Z])\.\s*(.*?)(?=(?:\nQ?\d+\.\s*The answer is\s+[A-Z]\.)|$)/gis;

  let m1;
  while ((m1 = regex1.exec(text)) !== null) {
    const number = Number(m1[1]);
    const letter = m1[2].toUpperCase();
    const feedback = cleanPageArtifacts(m1[3]).replace(/\s+/g, " ").trim();

    answers.set(number, {
      mode: "letter",
      correctLetter: letter,
      correctText: "",
      feedback
    });
  }

  // Format 2:
  // Q37. ...
  // Correct: Something
  // Feedback: Something
  const regex2 =
    /(?:^|\n)Q?(\d+)\.\s*(.*?)(?:\n|\r\n)Correct:\s*(.*?)(?:\n|\r\n)Feedback:\s*(.*?)(?=(?:\nQ?\d+\.\s)|$)/gis;

  let m2;
  while ((m2 = regex2.exec(text)) !== null) {
    const number = Number(m2[1]);
    const correctText = cleanPageArtifacts(m2[3]).replace(/\s+/g, " ").trim();
    const feedback = cleanPageArtifacts(m2[4]).replace(/\s+/g, " ").trim();

    answers.set(number, {
      mode: "text",
      correctLetter: "",
      correctText,
      feedback
    });
  }

  return answers;
}

function resolveCorrectIndex(question, answer) {
  if (!question || !answer) return -1;

  if (answer.mode === "letter" && answer.correctLetter) {
    const idx = question.choices.findIndex(
      (c) => c.letter.toUpperCase() === answer.correctLetter.toUpperCase()
    );
    return idx;
  }

  if (answer.mode === "text" && answer.correctText) {
    const target = normalizeForCompare(answer.correctText);

    // exact normalized text match
    let idx = question.choices.findIndex(
      (c) => normalizeForCompare(c.text) === target
    );
    if (idx !== -1) return idx;

    // contains fallback
    idx = question.choices.findIndex((c) => {
      const norm = normalizeForCompare(c.text);
      return norm.includes(target) || target.includes(norm);
    });
    return idx;
  }

  return -1;
}

function mergeBulkData(questionList, answerMap) {
  const merged = [];
  const skipped = [];

  for (const q of questionList) {
    const ans = answerMap.get(q.number);

    if (!ans) {
      skipped.push(`Q${q.number}: no matching answer key found`);
      continue;
    }

    const correctIndex = resolveCorrectIndex(q, ans);

    if (correctIndex < 0 || correctIndex >= q.choices.length) {
      skipped.push(
        `Q${q.number}: could not match correct answer to ${q.choices.length} choices`
      );
      continue;
    }

    merged.push({
      id: uid(),
      text: q.text,
      choices: q.choices.map((c) => c.text),
      correctIndex,
      feedback: ans.feedback || ""
    });
  }

  return { merged, skipped };
}

// ---------- Page ----------
async function initBulkMaker() {
  const el = (id) => document.getElementById(id);

  const quizSelect = el("quizSelect");
  const newQuizBtn = el("newQuizBtn");
  const quizTitle = el("quizTitle");
  const saveQuizTitleBtn = el("saveQuizTitleBtn");
  const deleteQuizBtn = el("deleteQuizBtn");

  const bulkQuestions = el("bulkQuestions");
  const bulkAnswers = el("bulkAnswers");
  const bulkImportBtn = el("bulkImportBtn");
  const bulkClearBtn = el("bulkClearBtn");

  const importPreview = el("importPreview");

  let activeQuiz = null;

  // create skip report area if not present
  let skipReport = document.getElementById("skipReport");
  if (!skipReport) {
    skipReport = document.createElement("div");
    skipReport.id = "skipReport";
    skipReport.className = "card";
    skipReport.style.marginTop = "14px";
    importPreview.parentElement.insertAdjacentElement("afterend", skipReport);
  }

  async function refreshQuizDropdown(activeId = null) {
    const quizzes = await loadAllQuizzes();
    quizSelect.innerHTML = "";

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = quizzes.length
      ? "Select a saved quiz…"
      : "No quizzes yet — click New Quiz";
    quizSelect.appendChild(opt0);

    quizzes.forEach((q) => {
      const o = document.createElement("option");
      o.value = q.id;
      o.textContent = q.title ? q.title : `Untitled (${q.id.slice(0, 6)})`;
      quizSelect.appendChild(o);
    });

    if (activeId) quizSelect.value = activeId;
  }

  function renderPreview() {
    importPreview.innerHTML = "";

    if (!activeQuiz || !activeQuiz.questions?.length) {
      importPreview.innerHTML = `<div class="muted">No imported questions yet.</div>`;
      return;
    }

    activeQuiz.questions.forEach((q, i) => {
      const item = document.createElement("div");
      item.className = "item";

      const correctText = q.choices[q.correctIndex] ?? "(missing)";
      item.innerHTML = `
        <div><strong>Q${i + 1}.</strong> ${escapeHtml(q.text)}</div>
        <div class="small muted" style="margin-top:6px;">
          Choices: ${q.choices.length}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Correct: <span class="ok">${escapeHtml(correctText)}</span>
        </div>
        ${
          q.feedback
            ? `<div class="small muted" style="margin-top:6px;">
                 Feedback: ${escapeHtml(q.feedback)}
               </div>`
            : ""
        }
      `;

      importPreview.appendChild(item);
    });
  }

  function renderSkipReport(skipped) {
    if (!skipped.length) {
      skipReport.innerHTML = `
        <h2>Import Report</h2>
        <div class="ok">No skipped questions.</div>
      `;
      return;
    }

    skipReport.innerHTML = `
      <h2>Import Report</h2>
      <div class="dangerText" style="margin-bottom:10px;">
        ${skipped.length} question(s) were skipped.
      </div>
      <div class="list">
        ${skipped.map((s) => `<div class="item small">${escapeHtml(s)}</div>`).join("")}
      </div>
    `;
  }

  function setActiveQuiz(quiz) {
    activeQuiz = quiz;
    quizTitle.value = quiz.title || "";
    renderPreview();
  }

  newQuizBtn.onclick = async () => {
    const q = {
      id: uid(),
      title: "Untitled Quiz",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      questions: []
    };

    await saveQuiz(q);
    await refreshQuizDropdown(q.id);
    setActiveQuiz(q);
    renderSkipReport([]);
  };

  quizSelect.onchange = async () => {
    const id = quizSelect.value;
    if (!id) {
      activeQuiz = null;
      quizTitle.value = "";
      renderPreview();
      renderSkipReport([]);
      return;
    }

    const q = await loadQuizById(id);
    if (!q) return;
    setActiveQuiz(q);
    renderSkipReport([]);
  };

  saveQuizTitleBtn.onclick = async () => {
    if (!activeQuiz) {
      alert("Create or select a quiz first.");
      return;
    }

    activeQuiz.title = quizTitle.value.trim() || "Untitled Quiz";
    await saveQuiz(activeQuiz);
    await refreshQuizDropdown(activeQuiz.id);
    alert("Quiz title saved.");
  };

  deleteQuizBtn.onclick = async () => {
    if (!activeQuiz) {
      alert("Select a quiz first.");
      return;
    }

    if (!confirm(`Delete quiz "${activeQuiz.title}"?`)) return;

    await deleteQuizById(activeQuiz.id);
    activeQuiz = null;
    quizTitle.value = "";
    await refreshQuizDropdown();
    renderPreview();
    renderSkipReport([]);
    alert("Quiz deleted.");
  };

  bulkImportBtn.onclick = async () => {
    if (!activeQuiz) {
      alert("Create or select a quiz first.");
      return;
    }

    const qRaw = bulkQuestions.value.trim();
    const aRaw = bulkAnswers.value.trim();

    if (!qRaw || !aRaw) {
      alert("Paste both the questions block and the answer key block.");
      return;
    }

    try {
      const parsedQuestions = parseQuestionBlock(qRaw);
      const parsedAnswers = parseAnswerKeyBlock(aRaw);
      const { merged, skipped } = mergeBulkData(parsedQuestions, parsedAnswers);

      renderSkipReport(skipped);

      if (!merged.length) {
        alert("No questions were imported. Check the Import Report below.");
        return;
      }

      activeQuiz.questions = activeQuiz.questions || [];
      activeQuiz.questions.push(...merged);

      await saveQuiz(activeQuiz);
      renderPreview();

      alert(`Imported ${merged.length} questions successfully.`);
    } catch (err) {
      console.error(err);
      alert("Import failed. Check the console for details.");
    }
  };

  bulkClearBtn.onclick = () => {
    bulkQuestions.value = "";
    bulkAnswers.value = "";
    renderSkipReport([]);
  };

  await refreshQuizDropdown();
  renderPreview();
  renderSkipReport([]);
}

// ---------- Theme Toggle ----------
(function () {
  const savedTheme = localStorage.getItem("quiz_theme");
  if (savedTheme) {
    document.body.dataset.theme = savedTheme === "light" ? "light" : "";
  }

  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "themeToggle") {
      const isLight = document.body.dataset.theme === "light";
      const next = isLight ? "dark" : "light";

      document.body.dataset.theme = next === "light" ? "light" : "";
      localStorage.setItem("quiz_theme", next);
    }
  });
})();

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  initBulkMaker().catch((err) => {
    console.error("Bulk maker init error:", err);
    alert("Failed to load bulk import page. Check console for details.");
  });
});
