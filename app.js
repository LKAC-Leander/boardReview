import { db } from "./firebase.js";
import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ---------- Utilities ----------
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function qs(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function base64UrlEncode(str) {
  const utf8 = new TextEncoder().encode(str);
  let bin = "";
  utf8.forEach((b) => (bin += String.fromCharCode(b)));
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(b64url) {
  const b64 =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array([...bin].map((ch) => ch.charCodeAt(0)));
  return new TextDecoder().decode(bytes);
}

function quizKey(id) {
  return `quiz_${id}`;
}

const QUIZ_COLLECTION = "quizzes";

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
  await setDoc(doc(db, QUIZ_COLLECTION, quiz.id), quiz); // write full quiz
}

async function deleteQuiz(id) {
  await deleteDoc(doc(db, QUIZ_COLLECTION, id));
}
async function loadQuizById(id) {
  const snap = await getDoc(doc(db, QUIZ_COLLECTION, id));
  return snap.exists() ? snap.data() : null;
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

// ---------- Maker Page ----------
function initMaker() {
  const el = (id) => document.getElementById(id);

  const quizSelect = el("quizSelect");
  const newQuizBtn = el("newQuizBtn");
  const delQuizBtn = el("delQuizBtn");
  const quizTitle = el("quizTitle");

  const qText = el("qText");
  const choicesWrap = el("choicesWrap");
  const addChoiceBtn = el("addChoiceBtn");
  const saveQuestionBtn = el("saveQuestionBtn");
  const cancelEditBtn = el("cancelEditBtn");

  const questionsList = el("questionsList");
  const shareBox = el("shareBox");
  const shareLinkEl = el("shareLink");
  const copyShareBtn = el("copyShareBtn");
  const openTakeBtn = el("openTakeBtn");

  let activeQuiz = null;
  let editingQuestionId = null;

  function setActiveQuiz(quiz) {
    activeQuiz = quiz;
    quizTitle.value = quiz.title || "";
    renderQuestions();
    renderShare();
    delQuizBtn.disabled = false;
    openTakeBtn.disabled = false;
  }

  function refreshQuizDropdown(activeId = null) {
    const quizzes = loadAllQuizzes();
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

  function clearQuestionForm() {
    qText.value = "";
    choicesWrap.innerHTML = "";
    editingQuestionId = null;
    cancelEditBtn.style.display = "none";
    for (let i = 0; i < 4; i++) addChoice("");
  }

  function addChoice(value = "") {
    const idx = choicesWrap.children.length;
    const row = document.createElement("div");
    row.className = "choice";
    row.innerHTML = `
      <input type="radio" name="correct" aria-label="Mark as correct" ${idx === 0 ? "checked" : ""}/>
      <input class="input" placeholder="Choice text" value="${escapeHtml(value)}"/>
      <button class="btn danger" type="button" title="Remove choice">Remove</button>
    `;

    row.querySelector("button").onclick = () => {
      if (choicesWrap.children.length <= 2) {
        alert("Keep at least 2 choices.");
        return;
      }
      row.remove();
      const radios = choicesWrap.querySelectorAll('input[type="radio"]');
      if (![...radios].some((r) => r.checked)) radios[0].checked = true;
    };

    choicesWrap.appendChild(row);
  }

  function renderQuestions() {
    if (!activeQuiz) return;
    questionsList.innerHTML = "";

    if (!activeQuiz.questions.length) {
      questionsList.innerHTML = `<div class="muted">No questions yet. Add one above.</div>`;
      return;
    }

    activeQuiz.questions.forEach((q, i) => {
      const item = document.createElement("div");
      item.className = "item";

      const correctText = q.choices[q.correctIndex] ?? "(missing)";
      item.innerHTML = `
        <div class="row tight" style="justify-content: space-between;">
          <div>
            <div><strong>Q${i + 1}.</strong> ${escapeHtml(q.text)}</div>
            <div class="small muted">Correct: <span class="ok">${escapeHtml(correctText)}</span></div>
          </div>
          <div class="row tight" style="gap:8px;">
            <button class="btn" type="button">Edit</button>
            <button class="btn danger" type="button">Delete</button>
          </div>
        </div>
      `;

      const [editBtn, delBtn] = item.querySelectorAll("button");

      editBtn.onclick = () => startEditQuestion(q.id);

      delBtn.onclick = () => {
        if (!confirm("Delete this question?")) return;
        activeQuiz.questions = activeQuiz.questions.filter((x) => x.id !== q.id);
        saveQuiz(activeQuiz);
        renderQuestions();
        renderShare();
        if (editingQuestionId === q.id) clearQuestionForm();
      };

      questionsList.appendChild(item);
    });
  }

  function startEditQuestion(qid) {
    const q = activeQuiz.questions.find((x) => x.id === qid);
    if (!q) return;

    editingQuestionId = qid;
    cancelEditBtn.style.display = "inline-flex";
    qText.value = q.text;

    choicesWrap.innerHTML = "";
    q.choices.forEach((c, idx) => {
      const row = document.createElement("div");
      row.className = "choice";
      row.innerHTML = `
        <input type="radio" name="correct" aria-label="Mark as correct" ${idx === q.correctIndex ? "checked" : ""}/>
        <input class="input" placeholder="Choice text" value="${escapeHtml(c)}"/>
        <button class="btn danger" type="button" title="Remove choice">Remove</button>
      `;

      row.querySelector("button").onclick = () => {
        if (choicesWrap.children.length <= 2) {
          alert("Keep at least 2 choices.");
          return;
        }
        row.remove();
        const radios = choicesWrap.querySelectorAll('input[type="radio"]');
        if (![...radios].some((r) => r.checked)) radios[0].checked = true;
      };

      choicesWrap.appendChild(row);
    });
  }

  function collectQuestionForm() {
    const text = qText.value.trim();
    if (!text) throw new Error("Question text is required.");

    const rows = [...choicesWrap.children];
    const choices = rows.map((r) => r.querySelector("input.input").value.trim());
    if (choices.some((c) => !c)) throw new Error("All choices must have text.");

    const correctIndex = rows.findIndex((r) =>
      r.querySelector('input[type="radio"]').checked
    );
    if (correctIndex < 0) throw new Error("Select a correct answer.");

    return { text, choices, correctIndex };
  }

  function renderShare() {
    if (!activeQuiz) {
      shareBox.style.display = "none";
      return;
    }
    shareBox.style.display = "block";

    const payload = {
      id: activeQuiz.id,
      title: activeQuiz.title,
      questions: activeQuiz.questions
    };

    const encoded = base64UrlEncode(JSON.stringify(payload));
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace(/maker\.html$/, "take.html");
    url.search = `?data=${encoded}`;

    shareLinkEl.textContent = url.toString();
  }

  newQuizBtn.onclick = () => {
    const q = {
      id: uid(),
      title: "Untitled Quiz",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      questions: []
    };
    saveQuiz(q);
    refreshQuizDropdown(q.id);
    setActiveQuiz(q);
    clearQuestionForm();
  };

  quizSelect.onchange = () => {
    const id = quizSelect.value;
    if (!id) {
      activeQuiz = null;
      quizTitle.value = "";
      questionsList.innerHTML = `<div class="muted">Select a quiz or create a new one.</div>`;
      shareBox.style.display = "none";
      delQuizBtn.disabled = true;
      openTakeBtn.disabled = true;
      return;
    }
    const q = loadQuizById(id);
    if (!q) return;
    setActiveQuiz(q);
    clearQuestionForm();
  };

  quizTitle.oninput = () => {
    if (!activeQuiz) return;
    activeQuiz.title = quizTitle.value.trim() || "Untitled Quiz";
    saveQuiz(activeQuiz);
    refreshQuizDropdown(activeQuiz.id);
    renderShare();
  };

  addChoiceBtn.onclick = () => addChoice("");

  cancelEditBtn.onclick = () => clearQuestionForm();

  saveQuestionBtn.onclick = () => {
    if (!activeQuiz) {
      alert("Create or select a quiz first.");
      return;
    }
    try {
      const data = collectQuestionForm();

      if (editingQuestionId) {
        const q = activeQuiz.questions.find((x) => x.id === editingQuestionId);
        if (!q) throw new Error("Question not found.");
        q.text = data.text;
        q.choices = data.choices;
        q.correctIndex = data.correctIndex;
      } else {
        activeQuiz.questions.push({ id: uid(), ...data });
      }

      saveQuiz(activeQuiz);
      renderQuestions();
      renderShare();
      clearQuestionForm();
    } catch (e) {
      alert(e.message || String(e));
    }
  };

  delQuizBtn.onclick = () => {
    if (!activeQuiz) return;
    if (!confirm("Delete this entire quiz?")) return;

    deleteQuiz(activeQuiz.id);
    activeQuiz = null;
    refreshQuizDropdown();
    quizTitle.value = "";
    questionsList.innerHTML = `<div class="muted">Select a quiz or create a new one.</div>`;
    shareBox.style.display = "none";
    delQuizBtn.disabled = true;
    openTakeBtn.disabled = true;
    clearQuestionForm();
  };

  copyShareBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(shareLinkEl.textContent);
      copyShareBtn.textContent = "Copied!";
      setTimeout(() => (copyShareBtn.textContent = "Copy"), 900);
    } catch {
      alert("Copy failed. You can manually copy the link.");
    }
  };

  openTakeBtn.onclick = () => {
    if (!activeQuiz) return;
    window.location.href = `take.html?id=${encodeURIComponent(activeQuiz.id)}`;
  };

  refreshQuizDropdown();
  delQuizBtn.disabled = true;
  openTakeBtn.disabled = true;
  cancelEditBtn.style.display = "none";
  questionsList.innerHTML = `<div class="muted">Select a quiz or create a new one.</div>`;
  clearQuestionForm();
}

// ---------- Take Page ----------
function initTake() {
  const el = (id) => document.getElementById(id);

  const titleEl = el("takeTitle");
  const metaEl = el("takeMeta");
  const formEl = el("takeForm");
  const submitBtn = el("submitBtn");

  let quiz = null;
  let mode = "local"; // local | shared

  function loadQuiz() {
    const dataParam = qs("data");
    const idParam = qs("id");

    if (dataParam) {
      try {
        const decoded = base64UrlDecode(dataParam);
        quiz = JSON.parse(decoded);
        mode = "shared";
        return;
      } catch {
        alert("Invalid shared quiz link.");
      }
    }

    if (idParam) {
      const q = loadQuizById(idParam);
      if (!q) {
        alert("Quiz not found in this browser.");
        return;
      }
      quiz = q;
      mode = "local";
      return;
    }

    quiz = null;
  }

  function renderQuizPicker() {
    const all = loadAllQuizzes();
    titleEl.textContent = "Take a Quiz";
    metaEl.innerHTML = `<span class="badge">Pick a saved quiz</span>`;
    formEl.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "card";
    wrap.innerHTML = `
      <h2>Choose a quiz</h2>
      <div class="row">
        <select id="picker" class="input">
          <option value="">Select…</option>
        </select>
        <button id="go" class="btn primary" type="button">Start</button>
      </div>
      <div class="muted small" style="margin-top:10px;">
        Or open a shared link (it will load automatically).
      </div>
    `;
    formEl.appendChild(wrap);

    const picker = wrap.querySelector("#picker");
    all.forEach((q) => {
      const o = document.createElement("option");
      o.value = q.id;
      o.textContent = q.title || `Untitled (${q.id.slice(0, 6)})`;
      picker.appendChild(o);
    });

    wrap.querySelector("#go").onclick = () => {
      if (!picker.value) return alert("Select a quiz.");
      window.location.href = `take.html?id=${encodeURIComponent(picker.value)}`;
    };

    submitBtn.style.display = "none";
  }

  function renderQuiz() {
    if (!quiz) return renderQuizPicker();

    titleEl.textContent = quiz.title || "Untitled Quiz";
    metaEl.innerHTML = `
      <span class="badge">${mode === "shared" ? "Shared quiz" : "Local quiz"}</span>
      <span class="badge">${quiz.questions.length} question(s)</span>
    `;

    if (!quiz.questions.length) {
      formEl.innerHTML = `<div class="card"><h2>No questions</h2><div class="muted">This quiz has no questions yet.</div></div>`;
      submitBtn.style.display = "none";
      return;
    }

    formEl.innerHTML = "";

    quiz.questions.forEach((q, idx) => {
      const card = document.createElement("div");
      card.className = "card";

      const choicesHtml = q.choices
        .map(
          (c, i) => `
          <label class="choice">
            <input type="radio" name="q_${q.id}" value="${i}" required />
            <span>${escapeHtml(c)}</span>
          </label>
        `
        )
        .join("");

      card.innerHTML = `
        <h2>Q${idx + 1}</h2>
        <div style="margin-bottom:10px;">${escapeHtml(q.text)}</div>
        <div>${choicesHtml}</div>
      `;

      formEl.appendChild(card);
    });

    submitBtn.style.display = "inline-flex";
  }

  function computeScore() {
    const answers = {};
    let correct = 0;

    quiz.questions.forEach((q) => {
      const picked = formEl.querySelector(`input[name="q_${q.id}"]:checked`);
      const pickedIndex = picked ? Number(picked.value) : null;
      answers[q.id] = pickedIndex;
      if (pickedIndex === q.correctIndex) correct++;
    });

    return {
      quizTitle: quiz.title || "Untitled Quiz",
      total: quiz.questions.length,
      correct,
      answers,
      questions: quiz.questions
    };
  }

  loadQuiz();
  renderQuiz();

  submitBtn.onclick = () => {
    if (!quiz) return;

    const valid = formEl.checkValidity();
    if (!valid) {
      formEl.reportValidity();
      return;
    }

    const result = computeScore();
    sessionStorage.setItem("lastResult", JSON.stringify(result));
    window.location.href = "results.html";
  };
}

// ---------- Results Page ----------
function initResults() {
  const el = (id) => document.getElementById(id);
  const titleEl = el("resTitle");
  const scoreEl = el("scoreLine");
  const reviewEl = el("reviewList");
  const againBtn = el("againBtn");

  const raw = sessionStorage.getItem("lastResult");
  if (!raw) {
    titleEl.textContent = "No results found";
    scoreEl.innerHTML = `<span class="muted">Take a quiz first.</span>`;
    reviewEl.innerHTML = "";
    againBtn.style.display = "none";
    return;
  }

  const result = JSON.parse(raw);
  titleEl.textContent = result.quizTitle || "Results";

  const percent = Math.round((result.correct / result.total) * 100);
  scoreEl.innerHTML = `
    <div class="row tight" style="gap:10px; flex-wrap:wrap;">
      <span class="badge">Score: <strong>${result.correct}/${result.total}</strong></span>
      <span class="badge">Percent: <strong>${percent}%</strong></span>
    </div>
  `;

  reviewEl.innerHTML = "";

  result.questions.forEach((q, idx) => {
    const picked = result.answers ? result.answers[q.id] : null;
    const ok = picked === q.correctIndex;

    const item = document.createElement("div");
    item.className = `item reviewItem ${ok ? "correct" : "wrong"}`;

    const statusPill = ok
      ? `<span class="pill correctPill">✅ Correct</span>`
      : `<span class="pill wrongPill">❌ Wrong</span>`;

    const choicesHtml = q.choices
      .map((c, i) => {
        let cls = "choiceRow";
        let mark = "⬜";

        if (i === q.correctIndex) {
          cls += " correct";
          mark = "✅";
        } else if (picked === i) {
          cls += " pickedWrong";
          mark = "❌";
        }

        return `
          <div class="${cls}">
            <div class="choiceMark">${mark}</div>
            <div class="choiceText">${escapeHtml(c)}</div>
          </div>
        `;
      })
      .join("");

    item.innerHTML = `
      <div class="row tight" style="justify-content: space-between; gap:10px; align-items:flex-start;">
        <div style="flex:1;">
          <div><strong>Q${idx + 1}.</strong> ${escapeHtml(q.text)}</div>
        </div>
        <div class="row tight" style="gap:8px;">
          ${statusPill}
        </div>
      </div>

      <div class="choiceList">
        ${choicesHtml}
      </div>
    `;

    reviewEl.appendChild(item);
  });

  againBtn.onclick = () => {
    window.location.href = "take.html";
  };
}

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "maker") initMaker();
  if (page === "take") initTake();
  if (page === "results") initResults();
});

// =========================
// THEME TOGGLE
// =========================
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

