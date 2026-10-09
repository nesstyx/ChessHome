// ═══════════════════════════════════════════════════════════════

const {
  app, db, uuidv4,
  authMiddleware, requireAdmin, rateLimit, limiterStrict,
  getUser, findSocketByUsername, logAdminAction,
  SYSTEM_SENDER, isSystemSender,
} = require('./core');

// ── Шаблоны: key → { label (для админа), ru, en (причина в тексте) } ──
const TEMPLATES = {
  spam:     { label: 'Реклама / спам',                     ru: 'реклама или спам',                                              en: 'advertising or spam' },
  flood:    { label: 'Флуд / одинаковые сообщения',        ru: 'флуд и многократное повторение одинаковых сообщений',           en: 'flooding and repeating the same message' },
  links:    { label: 'Внешние ссылки',                     ru: 'размещение внешних ссылок',                                     en: 'posting external links' },
  abuse:    { label: 'Оскорбления / токсичность',          ru: 'оскорбления и токсичное поведение',                             en: 'insults and toxic behavior' },
  manipulation: { label: 'Манипулирование игроками',      ru: 'манипулирование другими игроками (обман, давление, введение в заблуждение)', en: 'manipulating other players (deception, pressure, misleading)' },
  rating_manip: { label: 'Манипулирование рейтингом',    ru: 'манипулирование рейтингом или результатами партий (договорные партии, накрутка)', en: 'manipulating ratings or game results (match fixing, rating boosting)' },
  hate:     { label: 'Дискриминация / ненависть',        ru: 'дискриминация и разжигание вражды',                             en: 'discrimination and hate speech' },
  threats:  { label: 'Угрозы',                           ru: 'угрозы другим игрокам',                                         en: 'threatening other players' },
  impersonation: { label: 'Выдача себя за другого',      ru: 'выдача себя за администрацию или другого игрока',               en: 'impersonating staff or another player' },
  privacy:  { label: 'Личные данные других людей',       ru: 'публикация личных данных других людей',                         en: 'sharing other people\'s personal information' },
  cheating: { label: 'Подозрение на читерство',            ru: 'подозрение на использование подсказок или шахматного движка',  en: 'suspected use of engine assistance' },
  bad_name: { label: 'Недопустимое название / описание',   ru: 'недопустимое название или описание (клуб, турнир, профиль)',    en: 'inappropriate name or description (club, tournament, profile)' },
  content:  { label: 'Недопустимый контент (форум, блог)', ru: 'недопустимый контент на форуме или в блоге',                    en: 'inappropriate content on the forum or blog' },
  multi:    { label: 'Мультиаккаунты',                     ru: 'использование нескольких аккаунтов',                            en: 'using multiple accounts' },
  stalling: { label: 'Затягивание партий',                 ru: 'намеренное затягивание партий',                                 en: 'deliberately stalling games' },
  other:    { label: '✏️ Своё сообщение (напишу сам)',     ru: null, en: null },
};

function buildText(key, { auto = false } = {}) {
  const t = TEMPLATES[key];
  if (!t || !t.ru) return '';
  const ru = '⚠️ Предупреждение от администрации\n\n'
    + 'Причина: ' + t.ru + '.\n\n'
    + 'Пожалуйста, соблюдайте правила платформы. При повторных нарушениях аккаунт может быть заблокирован.'
    + (auto ? '\n\nЭто автоматическое сообщение. Если вы считаете, что это ошибка — обратитесь в поддержку.' : '');
  const en = '⚠️ Warning from the administration\n\n'
    + 'Reason: ' + t.en + '.\n\n'
    + 'Please follow the platform rules. Repeated violations may result in a ban.'
    + (auto ? '\n\nThis is an automatic message. If you think this is a mistake, please contact support.' : '');
  return ru + '\n\n— — —\n\n' + en;
}

async function countWarnings(low) {
  try { const r = await db('SELECT COUNT(*) AS n FROM user_warnings WHERE username_low=$1', [low]); return Number(r.rows[0].n); }
  catch { return 0; }
}
async function lastWarningAt(low) {
  try {
    const r = await db('SELECT created_at FROM user_warnings WHERE username_low=$1 ORDER BY created_at DESC LIMIT 1', [low]);
    return r.rows.length ? Number(r.rows[0].created_at) : 0;
  } catch { return 0; }
}

// source: 'admin' | 'bot'. Возвращает { ok, count } или { ok:false, status, error }.
async function sendWarning({ username, template, text, by, source = 'admin', score = null }) {
  const target = await getUser(String(username || '').toLowerCase());
  if (!target) return { ok: false, status: 404, error: 'Пользователь не найден' };
  if (isSystemSender(target.username)) return { ok: false, status: 400, error: 'Неверный получатель' };
  if (target.role === 'admin') return { ok: false, status: 400, error: 'Нельзя предупредить администратора' };
  if (target.banned) return { ok: false, status: 409, error: 'Пользователь уже забанен — предупреждение не нужно' };

  const body = String(text || '').trim() || buildText(template, { auto: source === 'bot' });
  if (!body) return { ok: false, status: 400, error: 'Введите текст предупреждения' };
  if (body.length > 2000) return { ok: false, status: 400, error: 'Максимум 2000 символов' };

  const msg = { id: uuidv4(), from: SYSTEM_SENDER, to: target.username, text: body, ts: new Date().toISOString(), read: false };
  await db('INSERT INTO dm_messages (id, from_user, to_user, text, ts, read) VALUES ($1,$2,$3,$4,$5,$6)',
    [msg.id, msg.from, msg.to, msg.text, msg.ts, msg.read]);
  const sock = findSocketByUsername(target.username);
  if (sock) sock.emit('dm_message', msg);

  const low = target.username.toLowerCase();
  await db(`INSERT INTO user_warnings (id, username, username_low, template, text, sent_by, source, score, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuidv4(), target.username, low, template || null, body, by, source, score, Date.now()]);
  await logAdminAction(by, 'warn', target.username, { template: template || 'custom', source, score, preview: body.slice(0, 120) });
  return { ok: true, count: await countWarnings(low), username: target.username };
}


// ── Админ-API ──
app.get('/api/admin/warning-templates', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    res.json(Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, text: buildText(key) })));
  });
});

app.get('/api/admin/warnings/:username', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const low = String(req.params.username || '').toLowerCase();
      const r = await db('SELECT * FROM user_warnings WHERE username_low=$1 ORDER BY created_at DESC LIMIT 20', [low]);
      res.json({
        count: await countWarnings(low),
        warnings: r.rows.map(w => ({
          id: w.id, template: w.template, label: (TEMPLATES[w.template] || {}).label || 'Своё сообщение',
          text: w.text, sentBy: w.sent_by, source: w.source, score: w.score, createdAt: Number(w.created_at),
        })),
      });
    } catch (e) { console.error('[Warnings list]', e); res.status(500).json({ error: e.message }); }
  });
});

app.post('/api/admin/warn', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const { username, template, text } = req.body || {};
      if (!username) return res.status(400).json({ error: 'Укажите игрока' });
      if (template && !TEMPLATES[template]) return res.status(400).json({ error: 'Неизвестный шаблон' });
      if (!String(text || '').trim() && (!template || template === 'other')) return res.status(400).json({ error: 'Введите текст предупреждения' });
      const out = await sendWarning({ username, template, text, by: req.user.username, source: 'admin' });
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      res.json({ ok: true, count: out.count });
    } catch (e) { console.error('[Warn]', e); res.status(500).json({ error: 'Ошибка отправки: ' + e.message }); }
  });
});

module.exports = { TEMPLATES, buildText, sendWarning, countWarnings, lastWarningAt };