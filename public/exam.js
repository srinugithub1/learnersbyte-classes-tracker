/* Student exam tab: paper list -> instructions -> sit the paper -> score.
 *
 * The paper the browser receives has no answer key in it — marking happens on
 * the server when the exam is submitted.
 *
 * Each question has its own countdown. When it reaches zero that question is
 * locked: the answer is saved with locked=true, and the server then refuses
 * any further change to it, so going back cannot reopen it. */

let EXAM_LIST = [];
let PAPER = null;          // { exam, attempt, questions }
let INDEX = 0;             // which question is on screen
let TICKER = null;         // the 1-second interval
let REMAINING = [];        // seconds left per question
let SAVING = false;

const fmtCountdown = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/* ------------------------------------------------------------ paper list */

async function loadExamList() {
  try {
    const { exams } = await api('/api/student/exams');
    EXAM_LIST = exams;
    renderExamList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

const PHASE_PILL = {
  open: '<span class="pill present"><span class="ico" aria-hidden="true">●</span>Open now</span>',
  'in-progress': '<span class="pill late"><span class="ico" aria-hidden="true">!</span>In progress</span>',
  upcoming: '<span class="pill pending"><span class="ico" aria-hidden="true">○</span>Upcoming</span>',
  closed: '<span class="pill absent"><span class="ico" aria-hidden="true">✕</span>Closed</span>',
  completed: '<span class="pill present"><span class="ico" aria-hidden="true">✓</span>Submitted</span>',
  'not-published': '<span class="pill pending"><span class="ico" aria-hidden="true">○</span>Not released</span>',
};

/* A missed paper says so plainly, and shows where the request has got to.
   Status is never colour alone — each pill carries an icon and words. */
const MAKEUP_PILL = {
  pending: '<span class="pill late"><span class="ico" aria-hidden="true">⏳</span>Makeup requested</span>',
  approved: '<span class="pill present"><span class="ico" aria-hidden="true">✓</span>Makeup approved</span>',
  rejected: '<span class="pill absent"><span class="ico" aria-hidden="true">✕</span>Makeup declined</span>',
};
const MISSED_PILL =
  '<span class="pill absent"><span class="ico" aria-hidden="true">✕</span>Missed</span>';

const examSidePill = (e) => {
  if (e.attempt && e.attempt.status === 'submitted') {
    return `<div class="score-chip ${e.attempt.percent >= 40 ? 'good' : 'bad'}">
              <b>${e.attempt.score}/${e.attempt.totalMarks}</b><span>${e.attempt.percent}%</span>
            </div>`;
  }
  if (e.makeup) return MAKEUP_PILL[e.makeup.status] || '';
  if (e.missed) return MISSED_PILL;
  return PHASE_PILL[e.window.phase] || '';
};

function renderExamList() {
  const mount = $('#examList');
  if (!EXAM_LIST.length) {
    mount.innerHTML = `<div class="table-empty">
      No exams have been released to your batch yet. They will appear here.</div>`;
    return;
  }

  mount.innerHTML = EXAM_LIST.map((e) => `
    <div class="exam-row" data-exam="${esc(e.id)}" role="button" tabindex="0">
      <div class="exam-row-main">
        <b>${esc(e.title || 'Untitled exam')}</b>
        <span class="small muted">
          ${fmtDate(e.examDate)} at ${fmtClock(e.startTime)} ·
          ${e.questionCount} question${e.questionCount === 1 ? '' : 's'} ·
          ${e.marksTotal} marks · ${e.secondsPerQuestion}s each
        </span>
      </div>
      <div class="exam-row-side">
        ${e.audience === 'selected'
          ? '<span class="pill pending"><span class="ico" aria-hidden="true">★</span>Makeup paper</span>'
          : ''}
        ${examSidePill(e)}
        <span class="chev" aria-hidden="true">›</span>
      </div>
    </div>`).join('');

  $$('#examList .exam-row').forEach((row) => {
    const open = () => openBrief(row.dataset.exam);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
  });
}

/* ---------------------------------------------------- instructions page */

function showExamScreen(which) {
  $('#examListWrap').classList.toggle('hidden', which !== 'list');
  $('#examBrief').classList.toggle('hidden', which !== 'brief');
  $('#examRunner').classList.toggle('hidden', which !== 'runner');
}

function openBrief(examId) {
  const exam = EXAM_LIST.find((e) => e.id === examId);
  if (!exam) return;

  $('#briefTitle').textContent = exam.title || 'Untitled exam';
  $('#briefMeta').textContent =
    `${fmtDate(exam.examDate)} at ${fmtClock(exam.startTime)} · ${MODE_TEXT[exam.questionMode]}`;

  $('#briefFacts').innerHTML = [
    ['Questions', exam.questionCount],
    ['Total marks', exam.marksTotal],
    ['Time per question', `${exam.secondsPerQuestion} sec`],
    ['Total time', `${Math.ceil((exam.questionCount * exam.secondsPerQuestion) / 60)} min`],
  ].map(([k, v]) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`).join('');

  $('#briefInstructions').innerHTML = exam.instructions
    ? esc(exam.instructions).replace(/\n/g, '<br>')
    : DEFAULT_INSTRUCTIONS(exam);

  renderGate(exam);
  showExamScreen('brief');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const MODE_TEXT = {
  fill: 'Fill in the blanks',
  mcq: 'Multiple choice',
  both: 'Fill in the blanks and multiple choice',
};

const DEFAULT_INSTRUCTIONS = (exam) => `
  <ul>
    <li>The paper has <strong>${exam.questionCount} question${exam.questionCount === 1 ? '' : 's'}</strong>
        worth <strong>${exam.marksTotal} marks</strong> in total.</li>
    <li>Questions appear <strong>one at a time</strong>. Use Previous and Next to move between them.</li>
    <li>Each question has its own timer of <strong>${exam.secondsPerQuestion} seconds</strong>.
        When it reaches zero that question <strong>locks</strong> and can no longer be changed.</li>
    <li>Your answers are saved as you go, so a refresh will not lose them.</li>
    <li>Press <strong>Submit exam</strong> on the last question. Your score is shown straight away.</li>
    <li>You may sit this exam <strong>once</strong>.</li>
  </ul>`;

function renderGate(exam) {
  const gate = $('#briefGate');
  const w = exam.window;

  if (exam.attempt && exam.attempt.status === 'submitted') {
    const a = exam.attempt;
    gate.innerHTML = `
      <div class="result-banner ${a.percent >= 40 ? 'pass' : 'fail'}">
        <div class="big">${a.score}<span>/${a.totalMarks}</span></div>
        <div class="meta">
          <b>${a.percent}%</b>
          <span>${a.correctCount} correct · ${a.wrongCount} wrong · ${a.unansweredCount} unanswered</span>
          <span class="small muted">Submitted ${fmtDateTime(a.submittedAt)}</span>
        </div>
      </div>
      <button class="btn ghost" id="viewAnswers">See the marked paper</button>`;
    $('#viewAnswers').addEventListener('click', () => showResult(exam.attempt.id));
    return;
  }

  // Missed it. Offer to ask the teacher, or show where that ask has got to.
  if (exam.missed || exam.makeup) {
    gate.innerHTML = renderMakeupGate(exam);
    const ask = $('#askMakeup');
    if (ask) ask.addEventListener('click', () => submitMakeupRequest(exam));
    return;
  }

  const canStart = w.canStart;
  gate.innerHTML = `
    <div class="gate ${canStart ? 'ready' : ''}">
      <div>
        <b>${canStart ? (w.phase === 'in-progress' ? 'You have this exam open' : 'You can begin') : 'Not open yet'}</b>
        <span class="small muted">${esc(w.message)}</span>
        ${!canStart && w.phase === 'upcoming'
          ? `<span class="small muted" id="countdownToStart"></span>` : ''}
      </div>
      <button class="btn xl" id="startExam" ${canStart ? '' : 'disabled'}>
        ${w.phase === 'in-progress' ? 'Continue exam' : 'Start exam'}
      </button>
    </div>`;

  if (canStart) $('#startExam').addEventListener('click', () => startExam(exam.id));

  // Live countdown so the button turns on by itself at the exam time.
  if (!canStart && w.phase === 'upcoming') {
    clearInterval(renderGate._timer);
    renderGate._timer = setInterval(() => {
      const left = (new Date(w.startsAt) - Date.now()) / 1000;
      const label = $('#countdownToStart');
      if (!label) { clearInterval(renderGate._timer); return; }
      if (left <= 0) {
        clearInterval(renderGate._timer);
        loadExamList().then(() => openBrief(exam.id));
        return;
      }
      const h = Math.floor(left / 3600);
      label.textContent = `Starts in ${h ? `${h}h ` : ''}${fmtCountdown(left % 3600)}`;
    }, 1000);
  }
}

/* ------------------------------------------------------- missed a paper */

/**
 * What a student sees on a paper they missed.
 *
 * A makeup is a different paper set by the teacher, not this one reopened, so
 * the wording never promises they will get these questions back.
 */
function renderMakeupGate(exam) {
  const m = exam.makeup;

  if (m && m.status === 'pending') {
    return `
      <div class="gate">
        <div>
          <b>Waiting for your teacher</b>
          <span class="small muted">You asked on ${fmtDateTime(m.createdAt)}.
            Your teacher will set a makeup paper if they agree.</span>
          ${m.reason ? `<span class="small muted">Your reason: “${esc(m.reason)}”</span>` : ''}
        </div>
      </div>`;
  }

  if (m && m.status === 'approved') {
    return `
      <div class="gate ready">
        <div>
          <b>A makeup paper has been set for you</b>
          <span class="small muted">Look for it in your exam list — it is a new paper,
            not this one. It will open at the time your teacher chose.</span>
          ${m.decisionNote ? `<span class="small muted">Teacher's note: “${esc(m.decisionNote)}”</span>` : ''}
        </div>
      </div>`;
  }

  if (m && m.status === 'rejected') {
    return `
      <div class="gate">
        <div>
          <b>Your teacher declined this request</b>
          <span class="small muted">${m.decisionNote
            ? `“${esc(m.decisionNote)}”`
            : 'Please speak to your teacher if you think this is a mistake.'}</span>
        </div>
      </div>`;
  }

  return `
    <div class="gate">
      <div>
        <b>You missed this exam</b>
        <span class="small muted">It closed on ${fmtDate(exam.examDate)}.
          You can ask your teacher for a second chance. If they agree they will
          set you a <strong>different paper</strong> with a new time.</span>
        <label class="field" style="margin-top:12px">
          <span>Why did you miss it?</span>
          <textarea id="makeupReason" rows="3" maxlength="500"
                    placeholder="For example: I was unwell and could not attend."></textarea>
        </label>
      </div>
      <button class="btn xl" id="askMakeup">Request to write</button>
    </div>`;
}

async function submitMakeupRequest(exam) {
  const btn = $('#askMakeup');
  const reason = ($('#makeupReason') && $('#makeupReason').value.trim()) || '';
  if (!reason) {
    toast('Please tell your teacher why you missed it.', 'warn');
    if ($('#makeupReason')) $('#makeupReason').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await api('/api/student/exam/makeup', { method: 'POST', body: { examId: exam.id, reason } });
    toast('Sent. Your teacher will decide.', 'ok');
    await loadExamList();
    openBrief(exam.id);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Request to write';
  }
}

$('#briefBack').addEventListener('click', async () => {
  await loadExamList();
  showExamScreen('list');
});

/* -------------------------------------------------------- sitting the paper */

async function startExam(examId) {
  const btn = $('#startExam');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  try {
    PAPER = await api('/api/student/exam/start', { method: 'POST', body: { examId } });
    // The server owns the clock. `remaining` already accounts for time spent on
    // a question the student opened earlier and came back to.
    REMAINING = PAPER.questions.map((q) => (q.locked
      ? 0
      : (typeof q.remaining === 'number'
        ? q.remaining
        : (q.seconds || PAPER.exam.secondsPerQuestion || 60))));
    INDEX = PAPER.questions.findIndex((q) => !q.locked);
    if (INDEX === -1) INDEX = 0;

    $('#runnerTitle').textContent = PAPER.exam.title || 'Exam';
    showExamScreen('runner');
    renderQuestion();
    startTicker();
    openCurrent();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Start exam'; }
    await loadExamList();
  }
}

function currentQuestion() {
  return PAPER.questions[INDEX];
}

function renderQuestion() {
  const q = currentQuestion();
  const total = PAPER.questions.length;

  $('#runnerProgress').textContent = `Question ${INDEX + 1} of ${total} · ${q.marks} mark${q.marks === 1 ? '' : 's'}`;

  $('#questionCard').innerHTML = `
    <div class="q-live ${q.locked ? 'locked' : ''}">
      <div class="q-live-head">
        <span class="q-num">${INDEX + 1}</span>
        <span class="q-type">${q.type === 'mcq' ? 'Multiple choice' : 'Fill in the blank'}</span>
        ${q.locked ? '<span class="pill absent"><span class="ico" aria-hidden="true">🔒</span>Time up — locked</span>' : ''}
      </div>

      <p class="q-live-text">${esc(q.questionText)}</p>

      ${q.type === 'mcq' ? `
        <div class="choices">
          ${q.options.map((o) => `
            <label class="choice ${q.yourAnswer === o.key ? 'chosen' : ''}">
              <input type="radio" name="answer" value="${esc(o.key)}"
                     ${q.yourAnswer === o.key ? 'checked' : ''} ${q.locked ? 'disabled' : ''} />
              <span class="key">${esc(o.key)}</span>
              <span class="text">${esc(o.text)}</span>
            </label>`).join('')}
        </div>`
      : `
        <label class="field">
          <span>Your answer</span>
          <input type="text" id="fillAnswer" value="${esc(q.yourAnswer || '')}"
                 placeholder="Type your answer" ${q.locked ? 'disabled' : ''} autocomplete="off" />
        </label>`}
    </div>`;

  if (!q.locked) {
    if (q.type === 'mcq') {
      $$('#questionCard input[name="answer"]').forEach((input) => {
        input.addEventListener('change', () => {
          q.yourAnswer = input.value;
          $$('#questionCard .choice').forEach((c) =>
            c.classList.toggle('chosen', c.contains(input) && input.checked));
          saveAnswer(false);
        });
      });
    } else {
      const input = $('#fillAnswer');
      input.addEventListener('input', () => { q.yourAnswer = input.value; });
      input.addEventListener('blur', () => saveAnswer(false));
    }
  }

  $('#prevQuestion').disabled = INDEX === 0;
  const last = INDEX === total - 1;
  $('#nextQuestion').hidden = last;
  $('#submitExam').hidden = !last;

  renderDots();
  paintTimer();
}

function renderDots() {
  $('#questionDots').innerHTML = PAPER.questions.map((q, i) => {
    const answered = String(q.yourAnswer || '').trim().length > 0;
    const cls = [
      i === INDEX ? 'here' : '',
      q.locked ? 'locked' : '',
      answered ? 'done' : '',
    ].filter(Boolean).join(' ');
    return `<button class="dot ${cls}" data-goto="${i}" title="Question ${i + 1}${
      q.locked ? ' (locked)' : answered ? ' (answered)' : ''}">${i + 1}</button>`;
  }).join('');

  $$('#questionDots .dot').forEach((d) =>
    d.addEventListener('click', () => goTo(Number(d.dataset.goto))));
}

async function goTo(index) {
  if (index < 0 || index >= PAPER.questions.length) return;
  await saveAnswer(false);
  INDEX = index;
  renderQuestion();
  openCurrent();
}

/**
 * Tell the server we are looking at this question, and take its word for how
 * long is left. The first visit starts the countdown; coming back does not
 * restart it, so the number we display is the real deadline.
 */
async function openCurrent() {
  const q = currentQuestion();
  if (!q || !PAPER || q.locked) return;
  const at = INDEX;
  try {
    const clock = await api('/api/student/exam/open', {
      method: 'POST',
      body: { attemptId: PAPER.attempt.id, questionId: q.id },
    });
    if (INDEX !== at) return;                 // moved on while we waited
    REMAINING[at] = clock.remaining;
    if (clock.locked) { q.locked = true; renderQuestion(); return; }
    paintTimer();
  } catch {
    /* Offline or slow: keep showing the local countdown. The server still has
       the final say when the answer is sent. */
  }
}

$('#prevQuestion').addEventListener('click', () => goTo(INDEX - 1));
$('#nextQuestion').addEventListener('click', () => goTo(INDEX + 1));

/* ------------------------------------------------------------- the timer */

function startTicker() {
  clearInterval(TICKER);
  let ticks = 0;
  TICKER = setInterval(() => {
    const q = currentQuestion();
    if (!q || q.locked) { paintTimer(); return; }

    REMAINING[INDEX] = Math.max(0, REMAINING[INDEX] - 1);
    paintTimer();

    // Re-ask the server now and then, so a drifting or meddled-with countdown
    // is pulled back to the real deadline rather than quietly running long.
    if (++ticks % 10 === 0) openCurrent();

    if (REMAINING[INDEX] === 0) lockCurrent();
  }, 1000);
}

function paintTimer() {
  const q = currentQuestion();
  const box = $('#questionTimer');
  if (!q) return;

  if (q.locked) {
    box.className = 'timer up';
    $('#timerValue').textContent = 'Locked';
    return;
  }
  const left = REMAINING[INDEX];
  box.className = `timer ${left <= 10 ? 'critical' : left <= 30 ? 'low' : ''}`;
  $('#timerValue').textContent = fmtCountdown(left);
}

/** Timer hit zero: save what is there and close the question for good. */
async function lockCurrent() {
  const q = currentQuestion();
  if (q.locked) return;
  q.locked = true;
  await saveAnswer(true);
  renderQuestion();
  toast(`Time up on question ${INDEX + 1} — it is now locked.`, 'warn');
}

async function saveAnswer(lock) {
  const q = currentQuestion();
  if (!q || !PAPER || SAVING) return;
  const at = INDEX;
  SAVING = true;
  try {
    const res = await api('/api/student/exam/answer', {
      method: 'POST',
      body: {
        attemptId: PAPER.attempt.id,
        questionId: q.id,
        answer: q.yourAnswer || '',
        lock: Boolean(lock),
      },
    });
    // The server may lock it even when we did not ask — its clock decides.
    if (res.answer.locked && !q.locked) {
      q.locked = true;
      REMAINING[at] = 0;
      if (INDEX === at) renderQuestion();
    } else if (typeof res.answer.remaining === 'number' && INDEX === at) {
      REMAINING[at] = res.answer.remaining;
      paintTimer();
    }
  } catch (err) {
    if (err.status === 409 && err.data && err.data.answer) {
      // Too late. Show what the server kept, not what we tried to send.
      q.locked = true;
      q.yourAnswer = err.data.answer.answer || '';
      REMAINING[at] = 0;
      if (INDEX === at) renderQuestion();
      toast(err.message, 'warn');
    } else {
      toast(err.message, 'error');
    }
  } finally {
    SAVING = false;
  }
}

/* ---------------------------------------------------------------- submit */

$('#submitExam').addEventListener('click', async () => {
  const unanswered = PAPER.questions.filter((q) => !String(q.yourAnswer || '').trim()).length;
  const warning = unanswered
    ? `\n\n${unanswered} question${unanswered === 1 ? ' is' : 's are'} still unanswered.`
    : '';
  if (!confirm(`Submit your exam now?${warning}\n\nYou cannot change your answers afterwards.`)) return;

  const btn = $('#submitExam');
  btn.disabled = true;
  btn.textContent = 'Marking…';
  try {
    await saveAnswer(false);
    const res = await api('/api/student/exam/submit', {
      method: 'POST', body: { attemptId: PAPER.attempt.id },
    });
    clearInterval(TICKER);
    showScorePopup(res.totals, res.results);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Submit exam';
  }
});

/* ----------------------------------------------------------- score popup */

function showScorePopup(totals, results) {
  const passed = totals.percent >= 40;
  const ring = 264;   // 2πr for r=42
  const dash = (ring * Math.min(totals.percent, 100)) / 100;

  const host = document.createElement('div');
  host.className = 'modal-backdrop score-backdrop';
  host.innerHTML = `
    <div class="modal score-modal" role="dialog" aria-modal="true" aria-label="Your exam score">
      <div class="score-hero ${passed ? 'pass' : 'fail'}">
        <svg viewBox="0 0 100 100" class="score-ring" aria-hidden="true">
          <circle cx="50" cy="50" r="42" class="ring-track" />
          <circle cx="50" cy="50" r="42" class="ring-fill"
                  style="stroke-dasharray:${dash} ${ring}" />
        </svg>
        <div class="score-center">
          <b>${totals.percent}%</b>
          <span>${totals.score} / ${totals.totalMarks}</span>
        </div>
      </div>

      <h2 class="score-title">${passed ? 'Well done!' : 'Exam submitted'}</h2>
      <p class="score-sub">${passed
        ? 'You have passed this exam.'
        : 'Your teacher can go through the answers with you.'}</p>

      <div class="score-grid">
        <div class="score-tile good">
          <span class="ico" aria-hidden="true">✓</span>
          <b>${totals.correctCount}</b><span>Correct</span>
        </div>
        <div class="score-tile bad">
          <span class="ico" aria-hidden="true">✕</span>
          <b>${totals.wrongCount}</b><span>Wrong</span>
        </div>
        <div class="score-tile muted">
          <span class="ico" aria-hidden="true">○</span>
          <b>${totals.unansweredCount}</b><span>Unanswered</span>
        </div>
        <div class="score-tile">
          <span class="ico" aria-hidden="true">#</span>
          <b>${totals.questionCount}</b><span>Questions</span>
        </div>
      </div>

      <footer>
        <button class="btn ghost" id="scoreClose">Back to exams</button>
        <button class="btn" id="scoreReview">See the answers</button>
      </footer>
    </div>`;

  document.body.appendChild(host);

  const close = async () => {
    host.remove();
    await loadExamList();
    showExamScreen('list');
    if (typeof loadExamHistory === 'function') loadExamHistory();
  };
  $('#scoreClose', host).addEventListener('click', close);
  $('#scoreReview', host).addEventListener('click', () => {
    host.remove();
    renderMarkedPaper(totals, results);
  });
}

/* --------------------------------------------------------- marked paper */

async function showResult(attemptId) {
  try {
    const { attempt, results } = await api(`/api/student/exam/result?attemptId=${encodeURIComponent(attemptId)}`);
    renderMarkedPaper({
      score: attempt.score, totalMarks: attempt.totalMarks, percent: attempt.percent,
      correctCount: attempt.correctCount, wrongCount: attempt.wrongCount,
      unansweredCount: attempt.unansweredCount, questionCount: attempt.questionCount,
    }, results);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderMarkedPaper(totals, results) {
  const host = document.createElement('div');
  host.className = 'modal-backdrop';
  host.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Your marked paper">
      <header>
        <h2>Your marked paper</h2>
        <span class="pill ${totals.percent >= 40 ? 'present' : 'absent'}">
          ${totals.score}/${totals.totalMarks} · ${totals.percent}%
        </span>
        <div class="spacer" style="margin-left:auto"></div>
        <button class="iconbtn" data-close>✕</button>
      </header>
      <div class="body">
        ${results.map((r) => `
          <div class="marked ${r.isCorrect ? 'right' : r.attempted ? 'wrong' : 'skipped'}">
            <div class="marked-head">
              <span class="q-num">${r.position}</span>
              <span class="q-type">${r.type === 'mcq' ? 'Multiple choice' : 'Fill in the blank'}</span>
              <div class="spacer" style="margin-left:auto"></div>
              <span class="pill ${r.isCorrect ? 'present' : r.attempted ? 'absent' : 'pending'}">
                <span class="ico" aria-hidden="true">${r.isCorrect ? '✓' : r.attempted ? '✕' : '○'}</span>
                ${r.isCorrect ? `+${r.marksAwarded}` : r.attempted ? 'Wrong' : 'Not answered'}
              </span>
            </div>
            <p class="marked-q">${esc(r.questionText)}</p>
            ${r.type === 'mcq' ? `
              <div>${r.options.map((o) => {
                const chosen = o.key === r.yourAnswer;
                const right = o.key === r.correctAnswer;
                return `<div class="opt-row ${right ? 'correct' : ''} ${chosen && !right ? 'chosen-wrong' : ''}">
                  <span class="opt-key">${esc(o.key)}</span>
                  <span>${esc(o.text)}</span>
                  ${right ? '<span class="tagline good">correct answer</span>' : ''}
                  ${chosen && !right ? '<span class="tagline bad">your answer</span>' : ''}
                </div>`;
              }).join('')}</div>`
            : `
              <div class="answer-lines">
                <div><span>Your answer</span><b>${r.attempted ? esc(r.yourAnswer) : '— not answered —'}</b></div>
                <div><span>Correct answer</span><b class="good">${esc(r.correctAnswer)}</b></div>
              </div>`}
          </div>`).join('')}
      </div>
      <footer><button class="btn" data-close>Close</button></footer>
    </div>`;

  document.body.appendChild(host);
  const close = async () => {
    host.remove();
    await loadExamList();
    showExamScreen('list');
    if (typeof loadExamHistory === 'function') loadExamHistory();
  };
  $$('[data-close]', host).forEach((b) => b.addEventListener('click', close));
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
}

/* ------------------------------------------- exam results in the report */

async function loadExamHistory() {
  try {
    const { attempts } = await api('/api/student/exam/history');
    const mount = $('#examResults');
    if (!mount) return;

    if (!attempts.length) {
      mount.innerHTML = '<div class="table-empty">You have not sat any exams yet.</div>';
      return;
    }

    const best = Math.max(...attempts.map((a) => a.percent));
    const average = Math.round((attempts.reduce((s, a) => s + a.percent, 0) / attempts.length) * 10) / 10;
    const totalCorrect = attempts.reduce((s, a) => s + a.correctCount, 0);
    const totalWrong = attempts.reduce((s, a) => s + a.wrongCount, 0);
    const totalQuestions = attempts.reduce((s, a) => s + a.questionCount, 0);

    mount.innerHTML = `
      <div class="stats compact" style="margin-bottom:16px">
        <div class="stat"><div class="label">Exams taken</div><div class="value">${attempts.length}</div></div>
        <div class="stat accent"><div class="label">Average</div><div class="value">${average}%</div></div>
        <div class="stat good"><div class="label">Best</div><div class="value">${best}%</div></div>
        <div class="stat good"><div class="label">Correct</div><div class="value">${totalCorrect}</div>
          <div class="foot">of ${totalQuestions} questions</div></div>
        <div class="stat bad"><div class="label">Wrong</div><div class="value">${totalWrong}</div></div>
      </div>

      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Exam</th><th>Date</th><th class="tnum">Questions</th>
            <th class="tnum">Correct</th><th class="tnum">Wrong</th><th class="tnum">Unanswered</th>
            <th class="tnum">Score</th><th></th>
          </tr></thead>
          <tbody>${attempts.map((a) => `
            <tr>
              <td><b>${esc(a.exam ? a.exam.title || 'Untitled exam' : '—')}</b></td>
              <td class="small">${a.exam ? fmtDate(a.exam.examDate) : '—'}</td>
              <td class="tnum">${a.questionCount}</td>
              <td class="tnum" style="color:var(--present);font-weight:650">${a.correctCount}</td>
              <td class="tnum" style="color:var(--absent);font-weight:650">${a.wrongCount}</td>
              <td class="tnum">${a.unansweredCount}</td>
              <td>${meter(a.percent)}<span class="small muted">${a.score}/${a.totalMarks}</span></td>
              <td><button class="btn ghost sm" data-review="${a.id}">Review</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    $$('#examResults [data-review]').forEach((b) =>
      b.addEventListener('click', () => showResult(b.dataset.review)));
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* Leaving the exam mid-way should not keep the clock running. */
window.addEventListener('beforeunload', (e) => {
  if (PAPER && $('#examRunner') && !$('#examRunner').classList.contains('hidden')) {
    e.preventDefault();
    e.returnValue = '';
  }
});
