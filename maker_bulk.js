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
  const text = normalizeWhitespace(raw);

  // Match each numbered question block
  const questionRegex = /(?:^|\n)(\d+)\.\s*(.*?)(?=(?:\n\d+\.\s)|$)/gs;
  const questions = [];
  let match;

  while ((match = questionRegex.exec(text)) !== null) {
    const number = Number(match[1]);
    let block = match[2].trim();

    // Skip blocks without choices
    if (!/\n[a-zA-Z]\)\s*/.test(block)) continue;

    const firstChoiceIndex = block.search(/\n[a-zA-Z]\)\s*/);
    if (firstChoiceIndex === -1) continue;

    let stem = block.slice(0, firstChoiceIndex).trim();
    const choicesPart = block.slice(firstChoiceIndex).trim();

    // Clean question stem
    stem = stem.replace(/\s+/g, " ").trim();

    // Supports a), b), c), d), e) ... z)
    const choiceRegex = /([a-zA-Z])\)\s*(.*?)(?=(?:\n[a-zA-Z]\)\s*)|$)/gs;
    const choices = [];
    let cMatch;

    while ((cMatch = choiceRegex.exec(choicesPart)) !== null) {
      const choiceText = cMatch[2].replace(/\s+/g, " ").trim();
      if (choiceText) choices.push(choiceText);
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
  const text = normalizeWhitespace(raw);

  // Matches:
  // 1. The answer is D. ...
  // 37. The answer is E. ...
  const answerRegex =
    /(?:^|\n)(\d+)\.\s*The answer is\s+([A-Z])\.\s*(.*?)(?=(?:\n\d+\.\s*The answer is\s+[A-Z]\.)|$)/gis;

  const answers = new Map();
  let match;

  while ((match = answerRegex.exec(text)) !== null) {
    const number = Number(match[1]);
    const letter = match[2].toUpperCase();
    const feedback = match[3].replace(/\s+/g, " ").trim();

    answers.set(number, {
      correctLetter: letter,
      correctIndex: letter.charCodeAt(0) - 65, // A=0, B=1, ...
      feedback
    });
  }

  return answers;
}

function mergeBulkData(questionList, answerMap) {
  const merged = [];

  for (const q of questionList) {
    const ans = answerMap.get(q.number);
    if (!ans) {
      console.warn(`Skipped Q${q.number}: no answer key found.`);
      continue;
    }

    if (ans.correctIndex < 0 || ans.correctIndex >= q.choices.length) {
      console.warn(
        `Skipped Q${q.number}: answer ${ans.correctLetter} does not match ${q.choices.length} choices.`
      );
      continue;
    }

    merged.push({
      id: uid(),
      text: q.text,
      choices: q.choices,
      correctIndex: ans.correctIndex,
      feedback: ans.feedback || ""
    });
  }

  return merged;
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
  };

  quizSelect.onchange = async () => {
    const id = quizSelect.value;
    if (!id) {
      activeQuiz = null;
      quizTitle.value = "";
      renderPreview();
      return;
    }

    const q = await loadQuizById(id);
    if (!q) return;
    setActiveQuiz(q);
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
      const mergedQuestions = mergeBulkData(parsedQuestions, parsedAnswers);

      if (!mergedQuestions.length) {
        alert("No questions were imported. Check the formatting and answer keys.");
        return;
      }

      activeQuiz.questions = activeQuiz.questions || [];
      activeQuiz.questions.push(...mergedQuestions);

      await saveQuiz(activeQuiz);
      renderPreview();

      alert(`Imported ${mergedQuestions.length} questions successfully.`);
    } catch (err) {
      console.error(err);
      alert("Import failed. Check the console for details.");
    }
  };

  bulkClearBtn.onclick = () => {
    bulkQuestions.value = "";
    bulkAnswers.value = "";
  };

  await refreshQuizDropdown();
  renderPreview();
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
