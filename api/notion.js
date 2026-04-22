const NOTION_TOKEN = process.env.NOTION_TOKEN;
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
        'Assigned To': { select: { name: assignee } },
        Done: { checkbox: false }
      };
      if (dueDate) properties['Due Date'] = { date: { start: dueDate } };
      if (goalId) properties['Goals'] = { relation: [{ id: goalId }] };
      const page = await createPage(TASKS_DB, properties);
      return res.status(200).json({ id: page.id });
    }

        return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
