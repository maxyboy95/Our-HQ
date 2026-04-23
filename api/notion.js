const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOALS_DB = process.env.GOALS_DB;
const TASKS_DB = process.env.TASKS_DB;
const HABITS_DB = process.env.HABITS_DB;
const HABIT_LOG_DB = process.env.HABIT_LOG_DB;

const notionHeaders = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

async function queryDatabase(dbId, filter) {
  const body = filter ? { filter } : {};
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify(body)
  });
  return res.json();
}

async function updatePage(pageId, properties) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders,
    body: JSON.stringify({ properties })
  });
  return res.json();
}

async function createPage(dbId, properties) {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify({ parent: { database_id: dbId }, properties })
  });
  return res.json();
}

function getTitle(page) {
  const title = page.properties?.Name?.title;
  return title?.[0]?.plain_text || '';
}

function getSelect(page, prop) {
  return page.properties?.[prop]?.select?.name || '';
}

function getDate(page, prop) {
  return page.properties?.[prop]?.date?.start || '';
}

function getCheckbox(page, prop) {
  return page.properties?.[prop]?.checkbox || false;
}

function getRelationIds(page, prop) {
  return page.properties?.[prop]?.relation?.map(r => r.id) || [];
}

module.exports = async (req, res) => {
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch(e) { req.body = {}; }
  }
  if (!req.body) req.body = {};
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'getData') {
      const [goalsRes, tasksRes, habitsRes, logsRes] = await Promise.all([
        queryDatabase(GOALS_DB),
        queryDatabase(TASKS_DB),
        queryDatabase(HABITS_DB),
        queryDatabase(HABIT_LOG_DB, {
          property: 'Date',
          date: { equals: new Date().toISOString().split('T')[0] }
        })
      ]);

      if (!goalsRes.results) return res.status(500).json({ error: `Goals DB failed: ${JSON.stringify(goalsRes)}` });
      if (!tasksRes.results) return res.status(500).json({ error: `Tasks DB failed: ${JSON.stringify(tasksRes)}` });
      if (!habitsRes.results) return res.status(500).json({ error: `Habits DB failed: ${JSON.stringify(habitsRes)}` });
      if (!logsRes.results) return res.status(500).json({ error: `Habit Log DB failed: ${JSON.stringify(logsRes)}` });

      const goals = goalsRes.results.map(p => ({
        id: p.id,
        name: getTitle(p),
        owner: getSelect(p, 'Owner'),
        category: getSelect(p, 'Category'),
        dueDate: getDate(p, 'Due Date'),
        status: getSelect(p, 'Status')
      }));

      const tasks = tasksRes.results.map(p => ({
        id: p.id,
        name: getTitle(p),
        assignedTo: getSelect(p, 'Assigned To'),
        dueDate: getDate(p, 'Due Date'),
        done: getCheckbox(p, 'Done'),
        goalIds: getRelationIds(p, 'Goals')
      }));

      const habits = habitsRes.results.map(p => ({
        id: p.id,
        name: getTitle(p),
        assignedTo: getSelect(p, 'Assigned To')
      }));

      const todayLogs = logsRes.results.map(p => ({
        id: p.id,
        habitId: getRelationIds(p, 'Habit')[0] || '',
        sashankh: getCheckbox(p, 'Sashankh'),
        spoorthi: getCheckbox(p, 'Spoorthi'),
        date: getDate(p, 'Date')
      }));

      return res.status(200).json({ goals, tasks, habits, todayLogs });
    }

    if (action === 'toggleTask') {
      const { pageId, done } = req.body;
      await updatePage(pageId, { Done: { checkbox: done } });
      return res.status(200).json({ ok: true });
    }

    if (action === 'toggleHabit') {
      const { logId, person, value, habitId } = req.body;
      const today = new Date().toISOString().split('T')[0];

      if (logId) {
        const prop = person === 'sashankh' ? 'Sashankh' : 'Spoorthi';
        await updatePage(logId, { [prop]: { checkbox: value } });
      } else {
        await createPage(HABIT_LOG_DB, {
          Name: { title: [{ text: { content: `${today} — log` } }] },
          Date: { date: { start: today } },
          Habit: { relation: [{ id: habitId }] },
          Sashankh: { checkbox: person === 'sashankh' ? value : false },
          Spoorthi: { checkbox: person === 'spoorthi' ? value : false }
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'getWeeklyStats') {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const weekAgoStr = weekAgo.toISOString().split('T')[0];

      const logsRes = await queryDatabase(HABIT_LOG_DB, {
        property: 'Date',
        date: { on_or_after: weekAgoStr }
      });

      const stats = {};
      logsRes.results.forEach(p => {
        const habitId = getRelationIds(p, 'Habit')[0];
        if (!habitId) return;
        if (!stats[habitId]) stats[habitId] = { sashankh: 0, spoorthi: 0 };
        if (getCheckbox(p, 'Sashankh')) stats[habitId].sashankh++;
        if (getCheckbox(p, 'Spoorthi')) stats[habitId].spoorthi++;
      });

      return res.status(200).json({ stats });
    }

    if (action === 'addTask') {
      const { name, assignee, dueDate, goalId } = req.body;
      const properties = {
        Name: { title: [{ text: { content: name } }] },
        'Assigned to': { select: { name: assignee } },
        Done: { checkbox: false }
      };
      if (dueDate) properties['Due Date'] = { date: { start: dueDate } };
      if (goalId) properties['Goals'] = { relation: [{ id: goalId }] };
      const res2 = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({ parent: { database_id: TASKS_DB }, properties })
      });
      const page = await res2.json();
      if (!res2.ok) return res.status(400).json({ error: 'Notion error: ' + JSON.stringify(page) });
      return res.status(200).json({ id: page.id });
    }

        if (action === 'getBriefing') {
      const today = new Date().toISOString().split('T')[0];
      const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      const [tasksRes, habitsRes, newsRes] = await Promise.all([
        queryDatabase(TASKS_DB),
        queryDatabase(HABITS_DB),
        fetch(`https://newsapi.org/v2/top-headlines?country=in&pageSize=5&apiKey=${NEWS_API_KEY}`)
      ]);

      const tasks = tasksRes.results.map(p => ({
        name: getTitle(p),
        assignedTo: getSelect(p, 'Assigned to'),
        dueDate: getDate(p, 'Due Date'),
        done: getCheckbox(p, 'Done')
      })).filter(t => !t.done);

      const todayTasks = tasks.filter(t => t.dueDate === today);
      const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < today);
      const habits = habitsRes.results.map(p => getTitle(p));

      const newsData = await newsRes.json();
      const headlines = (newsData.articles || []).slice(0, 5).map(a => a.title).filter(Boolean);

      const sashankhTasks = todayTasks.filter(t => t.assignedTo?.toLowerCase() === 'sashankh' || t.assignedTo?.toLowerCase() === 'shared');
      const spoorthiTasks = todayTasks.filter(t => t.assignedTo?.toLowerCase() === 'spoorthi' || t.assignedTo?.toLowerCase() === 'shared');

      const prompt = \`You are a friendly personal assistant called Jarvis. Generate a warm, natural morning briefing for Sashankh. Keep it conversational, upbeat and under 120 words. Speak directly to Sashankh.

Today is \${dayName}, \${dateStr}.

Sashankh's tasks today: \${sashankhTasks.map(t => t.name).join(', ') || 'none'}
Spoorthi's tasks today: \${spoorthiTasks.map(t => t.name).join(', ') || 'none'}
Overdue tasks: \${overdueTasks.map(t => t.name + ' (assigned to ' + t.assignedTo + ')').join(', ') || 'none'}
Daily habits to complete: \${habits.join(', ') || 'none'}
Top news headlines: \${headlines.join(' | ')}

Generate a single spoken paragraph briefing. Do not use bullet points or markdown. Make it sound like a real assistant speaking.\`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const claudeData = await claudeRes.json();
      const briefing = claudeData.content?.[0]?.text || 'Good morning! Have a great day.';

      return res.status(200).json({ briefing, todayTasks, overdueTasks, habits, headlines });
    }

        return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
