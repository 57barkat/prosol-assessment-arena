const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_FILE = process.env.ASSESSMENT_DATA_FILE || path.join(ROOT, 'data', 'assessment-state.json');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = "prosol123";
const COOKIE_SECURE = process.env.NODE_ENV !== 'development';
const GROUPS = ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5'];
const DEFAULT_STATE = {
  participants: {},
  resultsReleased: false,
  settings: { quizSize: 5, quizSeconds: 180 }
};
const sessions = new Map();
let state = loadState();
let writeQueue = Promise.resolve();

// if (ADMIN_PASSWORD.length < 12) {
//   throw new Error('Set ADMIN_PASSWORD to a value of at least 12 characters before starting the server.');
// }

function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      participants: loaded.participants && typeof loaded.participants === 'object' ? loaded.participants : {},
      resultsReleased: loaded.resultsReleased === true,
      settings: {
        quizSize: clampInt(loaded.settings && loaded.settings.quizSize, 1, 100, 5),
        quizSeconds: clampInt(loaded.settings && loaded.settings.quizSeconds, 60, 3600, 180)
      }
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return structuredClone(DEFAULT_STATE);
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isNaN(number) ? fallback : Math.min(max, Math.max(min, number));
}

function persistState() {
  const contents = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const temporaryFile = `${DATA_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryFile, contents, 'utf8');
    await fs.promises.rename(temporaryFile, DATA_FILE);
  });
  return writeQueue;
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function adminSession(request) {
  const cookie = request.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)ps_admin_session=([a-f0-9]+)/);
  if (!match) return false;
  const expiresAt = sessions.get(match[1]);
  if (!expiresAt || expiresAt < Date.now()) {
    sessions.delete(match[1]);
    return false;
  }
  return true;
}

function participantScore(participant) {
  const questions = Array.isArray(participant.questions) ? participant.questions : [];
  let score = 0;
  questions.forEach((question, index) => {
    if (Number(participant.answers && participant.answers[index]) === question.answerIndex) score++;
  });
  return {
    score,
    total: questions.length,
    percentage: questions.length ? Math.round(score / questions.length * 100) : 0
  };
}

function publicSummary() {
  const participants = Object.values(state.participants);
  const groupAverages = GROUPS.map(group => {
    const submitted = participants.filter(participant => participant.group === group && participant.submitted);
    const average = submitted.length
      ? Math.round(submitted.reduce((sum, participant) => sum + participantScore(participant).percentage, 0) / submitted.length)
      : 0;
    return { group, count: submitted.length, avg: state.resultsReleased ? average : 0 };
  }).sort((first, second) => second.avg - first.avg);

  return {
    participants: participants.map(({ group, submitted }) => ({ group, submitted })),
    resultsReleased: state.resultsReleased,
    groupAverages
  };
}

async function handleApi(request, response, url) {
  const { pathname } = url;

  if (request.method === 'GET' && pathname === '/api/config') {
    return sendJson(response, 200, { settings: state.settings });
  }

  if (request.method === 'GET' && pathname === '/api/summary') {
    return sendJson(response, 200, publicSummary());
  }

  if (request.method === 'POST' && pathname === '/api/admin/login') {
    const body = await readJson(request);
    if (typeof body.password !== 'string' || body.password !== ADMIN_PASSWORD) {
      return sendJson(response, 401, { error: 'Invalid admin password.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
    const secure = COOKIE_SECURE ? '; Secure' : '';
    return sendJson(response, 200, { ok: true }, {
      'Set-Cookie': `ps_admin_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${secure}`
    });
  }

  if (request.method === 'POST' && pathname === '/api/admin/logout') {
    const cookie = request.headers.cookie || '';
    const match = cookie.match(/(?:^|;\s*)ps_admin_session=([a-f0-9]+)/);
    if (match) sessions.delete(match[1]);
    return sendJson(response, 200, { ok: true }, {
      'Set-Cookie': 'ps_admin_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0'
    });
  }

  if (request.method === 'GET' && pathname.startsWith('/api/admin/')) {
    if (!adminSession(request)) return sendJson(response, 401, { error: 'Admin login required.' });
    if (pathname === '/api/admin/state') return sendJson(response, 200, state);
  }

  if (request.method === 'PATCH' && pathname === '/api/admin/settings') {
    if (!adminSession(request)) return sendJson(response, 401, { error: 'Admin login required.' });
    const body = await readJson(request);
    state.settings = {
      quizSize: clampInt(body.quizSize, 1, 100, state.settings.quizSize),
      quizSeconds: clampInt(body.quizSeconds, 60, 3600, state.settings.quizSeconds)
    };
    await persistState();
    return sendJson(response, 200, { settings: state.settings });
  }

  if (request.method === 'PATCH' && pathname === '/api/admin/results') {
    if (!adminSession(request)) return sendJson(response, 401, { error: 'Admin login required.' });
    const body = await readJson(request);
    if (typeof body.released !== 'boolean') return sendJson(response, 400, { error: 'released must be a boolean.' });
    state.resultsReleased = body.released;
    await persistState();
    return sendJson(response, 200, { resultsReleased: state.resultsReleased });
  }

  if (request.method === 'DELETE' && pathname === '/api/admin/state') {
    if (!adminSession(request)) return sendJson(response, 401, { error: 'Admin login required.' });
    state.participants = {};
    state.resultsReleased = false;
    await persistState();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/participants') {
    const body = await readJson(request);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) {
      return sendJson(response, 400, { error: 'A participant name of 1 to 120 characters is required.' });
    }
    if (!GROUPS.includes(body.group) || !Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > 100) {
      return sendJson(response, 400, { error: 'A valid group and question list are required.' });
    }
    if (body.questions.some(question =>
      !question || typeof question.question !== 'string' || !Array.isArray(question.options) ||
      question.options.length !== 4 || !Number.isInteger(question.answerIndex) ||
      question.answerIndex < 0 || question.answerIndex > 3
    )) {
      return sendJson(response, 400, { error: 'The question list contains an invalid question.' });
    }
    const id = crypto.randomUUID();
    const participant = {
      id,
      name: body.name.trim(),
      group: body.group,
      questions: body.questions,
      answers: {},
      startedAt: new Date().toISOString(),
      remainingSeconds: state.settings.quizSeconds,
      submitted: false
    };
    state.participants[id] = participant;
    await persistState();
    return sendJson(response, 201, { participant });
  }

  const participantMatch = pathname.match(/^\/api\/participants\/([a-f0-9-]+)$/i);
  if (participantMatch) {
    const participant = state.participants[participantMatch[1]];
    if (!participant) return sendJson(response, 404, { error: 'Participant attempt not found.' });

    if (request.method === 'GET') return sendJson(response, 200, { participant });
    if (request.method === 'PATCH') {
      if (participant.submitted) return sendJson(response, 409, { error: 'This quiz has already been submitted.' });
      const body = await readJson(request);
      if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) {
        return sendJson(response, 400, { error: 'answers must be an object.' });
      }
      const answers = {};
      for (const [index, answer] of Object.entries(body.answers)) {
        const questionIndex = Number(index);
        const question = participant.questions[questionIndex];
        if (!Number.isInteger(questionIndex) || !question || !Number.isInteger(answer) || answer < 0 || answer > 3) {
          return sendJson(response, 400, { error: 'An answer is invalid.' });
        }
        answers[questionIndex] = answer;
      }
      const remainingSeconds = Number(body.remainingSeconds);
      if (!Number.isInteger(remainingSeconds) || remainingSeconds < 0 || remainingSeconds > 3600) {
        return sendJson(response, 400, { error: 'remainingSeconds must be a valid non-negative integer.' });
      }
      participant.answers = answers;
      participant.remainingSeconds = remainingSeconds;
      if (body.submitted === true) {
        const required = Math.ceil(participant.questions.length * 0.7);
        if (Object.keys(answers).length < required && remainingSeconds !== 0) {
          return sendJson(response, 400, { error: 'Answer at least 70% of questions before submitting.' });
        }
        participant.submitted = true;
        participant.submittedAt = new Date().toISOString();
      }
      await persistState();
      return sendJson(response, 200, { participant });
    }
  }

  return sendJson(response, 404, { error: 'API route not found.' });
}

function serveStatic(request, response, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || filePath.startsWith(path.join(ROOT, 'data') + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const types = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.txt': 'text/plain; charset=utf-8'
    };
    response.writeHead(200, {
      'Content-Type': types[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      serveStatic(request, response, url);
    } else {
      sendJson(response, 405, { error: 'Method not allowed.' });
    }
  } catch (error) {
    console.error('Request failed:', error);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
    else response.destroy(error);
  }
});

server.listen(PORT, () => {
  console.log(`ProSol Assessment Arena listening on port ${PORT}`);
});
