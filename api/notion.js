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
        fetch('https://newsapi.org/v2/everything?q=india&sortBy=publishedAt&pageSize=5&language=en&apiKey=' + NEWS_API_KEY)
      ]);

      const allTasks = tasksRes.results.map(p => ({
        name: getTitle(p),
        assignedTo: getSelect(p, 'Assigned to'),
        dueDate: getDate(p, 'Due Date'),
        done: getCheckbox(p, 'Done')
      }));

      const pendingTasks = allTasks.filter(t => !t.done);
      const todayTasks = pendingTasks.filter(t => t.dueDate === today);
      const overdueTasks = pendingTasks.filter(t => t.dueDate && t.dueDate < today);
      const habits = habitsRes.results.map(p => getTitle(p));

      const newsData = await newsRes.json();
      const headlines = (newsData.articles || []).slice(0, 5).map(a => a.title).filter(Boolean);

      const sashankhTasks = pendingTasks.filter(t => {
        const a = (t.assignedTo || '').toLowerCase();
        return a === 'sashankh' || a === 'shared';
      });
      const spoorthiTasks = pendingTasks.filter(t => {
        const a = (t.assignedTo || '').toLowerCase();
        return a === 'spoorthi' || a === 'shared';
      });

      const systemPrompt = 'You are J.A.R.V.I.S., the AI assistant from Iron Man. You speak with sophisticated British wit, precision and dry intelligence. You are calm, composed and slightly formal but with subtle warmth. Address Sashankh as "sir". Never use casual language. Keep responses under 150 words and speak in a single flowing paragraph as if being read aloud.';

      const userPrompt = 'Generate the morning briefing for sir. Today is ' + dayName + ', ' + dateStr + '. ' +
        'Pending tasks for Sashankh: ' + (sashankhTasks.map(t => t.name).join(', ') || 'none') + '. ' +
        'Pending tasks for Spoorthi: ' + (spoorthiTasks.map(t => t.name).join(', ') || 'none') + '. ' +
        'Overdue items requiring immediate attention: ' + (overdueTasks.map(t => t.name).join(', ') || 'none') + '. ' +
        'Daily habits scheduled: ' + (habits.join(', ') || 'none') + '. ' +
        'Top news headlines: ' + (headlines.join('. ') || 'No headlines available') + '. ' +
        'Deliver the briefing in character as J.A.R.V.I.S. in a single spoken paragraph with no formatting.';

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 350,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });

      const claudeData = await claudeRes.json();

      let briefing = 'Good morning, sir. Systems are online and awaiting your command.';
      if (claudeData.content && Array.isArray(claudeData.content) && claudeData.content.length > 0) {
        briefing = claudeData.content[0].text || briefing;
      } else if (claudeData.error) {
        briefing = 'Good morning, sir. I am experiencing a minor systems issue: ' + claudeData.error.message;
      }

      return res.status(200).json({ briefing, todayTasks, overdueTasks, habits, headlines, debug: { claudeStatus: claudeRes.status, hasContent: !!(claudeData.content && claudeData.content.length) } });
    }

        if (action === 'jarvis') {
      const { message, history, context } = req.body;

      const systemPrompt = 'You are J.A.R.V.I.S., the AI assistant from Iron Man. Speak with sophisticated British wit, precision and dry intelligence. Address Sashankh as "sir". You have full knowledge of his goals, tasks and habits. You can take actions by including a JSON block at the end of your response in this exact format if needed: ACTION:{"action":"addTask","actionData":{"name":"task name","assignee":"Sashankh","dueDate":"2026-04-23"}} or ACTION:{"action":"reload"} or ACTION:{"action":"toggleTask","actionData":{"pageId":"id","done":true}}. Only include ACTION if the user explicitly asks you to do something. Keep responses under 100 words unless asked for detail.';

      const contextSummary = 'Current date: ' + context.dayName + ', ' + context.dateStr + '. ' +
        'Active goals: ' + context.goals.map(g => g.name + ' (' + g.owner + ')').join(', ') + '. ' +
        'Pending tasks: ' + context.tasks.filter(t => !t.done).map(t => t.name + ' assigned to ' + t.assignedTo + (t.dueDate ? ' due ' + t.dueDate : '')).join(', ') + '. ' +
        'Daily habits: ' + context.habits.map(h => h.name).join(', ') + '.';

      const messages = [
        { role: 'user', content: 'Context: ' + contextSummary },
        { role: 'assistant', content: 'Understood sir. I have your current status loaded and am ready to assist.' },
        ...history.slice(-8),
        { role: 'user', content: message }
      ];

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 400,
          system: systemPrompt,
          messages
        })
      });

      const claudeData = await claudeRes.json();
      let fullReply = claudeData.content && claudeData.content[0] ? claudeData.content[0].text : 'My apologies sir, I seem to be experiencing a systems issue.';

      let reply = fullReply;
      let actionObj = null;

      const actionMatch = fullReply.match(/ACTION:(\{.*\})/);
      if (actionMatch) {
        try {
          actionObj = JSON.parse(actionMatch[1]);
          reply = fullReply.replace(/ACTION:\{.*\}/, '').trim();
        } catch(e) {}
      }

      return res.status(200).json({ reply, action: actionObj ? actionObj.action : null, actionData: actionObj ? actionObj.actionData : null });
    }

        return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
