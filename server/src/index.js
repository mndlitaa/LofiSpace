import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) console.warn('Set SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env');
const db = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
// Keep Auth session state separate so signing in never replaces the backend DB key.
const authClient = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '100kb' }));

const audioBucket = 'lofspace-audio';
const asyncWrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, data, status = 200) => res.status(status).json({ data });
const notFound = res => res.status(404).json({ error: 'Record not found' });
const idOf = req => Number.isInteger(+req.params.id) && +req.params.id > 0 ? +req.params.id : null;
const run = async query => {
  if (!db) throw Object.assign(new Error('Supabase is not configured'), { code: 'SUPABASE_CONFIG' });
  const { data, error } = await query;
  if (error) throw error;
  return data;
};
const taskInput = (body, old = {}) => ({
  title: String(body.title ?? old.title ?? '').trim(),
  description: String(body.description ?? old.description ?? '').slice(0, 2000),
  priority: body.priority ?? old.priority ?? 'medium',
  target_minutes: Number(body.target_minutes ?? old.target_minutes ?? 25),
  completed: body.completed === undefined ? Boolean(old.completed ?? false) : Boolean(body.completed)
});
const validTask = x => x.title && ['low', 'medium', 'high'].includes(x.priority) && Number.isInteger(x.target_minutes) && x.target_minutes >= 5 && x.target_minutes <= 600;
const withTaskTitle = rows => rows.map(({ tasks, ...row }) => ({ ...row, task_title: tasks?.title || null }));

const publicUser = (authUser, account) => ({
  id: account.id,
  email: authUser.email,
  username: account.username,
  bio: account.bio,
  avatar: account.avatar,
  avatar_frame: account.avatar_frame || 'sunny'
});
const sessionPayload = session => ({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at });
const ensureAccount = async authUser => {
  let account = await run(db.from('users').select('*').eq('auth_user_id', authUser.id).maybeSingle());
  if (account) return account;
  const metadataName = String(authUser.user_metadata?.username || authUser.email?.split('@')[0] || 'Little Dreamer').trim().slice(0, 80);
  const legacy = await run(db.from('users').select('*').eq('id', 1).is('auth_user_id', null).maybeSingle());
  if (legacy) {
    const claim = { auth_user_id: authUser.id };
    if (legacy.username === 'Little Dreamer') claim.username = metadataName;
    account = await run(db.from('users').update(claim).eq('id', 1).is('auth_user_id', null).select().maybeSingle());
    if (account) return account;
    account = await run(db.from('users').select('*').eq('auth_user_id', authUser.id).maybeSingle());
    if (account) return account;
  }
  account = await run(db.from('users').insert({ auth_user_id: authUser.id, username: metadataName, bio: '', avatar: '🌙', avatar_frame: 'sunny' }).select().single());
  return account;
};
const requireAuth = asyncWrap(async (req, res, next) => {
  if (!db) return res.status(503).json({ error: 'Supabase is not configured' });
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Please sign in to continue' });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  req.authUser = data.user;
  req.authToken = token;
  req.authAccount = await ensureAccount(data.user);
  req.userId = req.authAccount.id;
  next();
});

app.get('/api/health', asyncWrap(async (_req, res) => {
  await run(db?.from('users').select('id').limit(1));
  ok(res, { status: 'ok', database: 'supabase' });
}));

app.post('/api/auth/signup', asyncWrap(async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Supabase is not configured' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const username = String(req.body?.username || '').trim().slice(0, 80);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!username) return res.status(400).json({ error: 'Enter a display name' });
  const { data, error } = await authClient.auth.signUp({ email, password, options: { data: { username } } });
  if (error) return res.status(400).json({ error: error.message });
  if (!data.user) return res.status(400).json({ error: 'Could not create this account' });
  if (!data.session) return ok(res, { needsEmailConfirmation: true, email: data.user.email }, 201);
  const account = await ensureAccount(data.user);
  ok(res, { user: publicUser(data.user, account), session: sessionPayload(data.session) }, 201);
}));
app.post('/api/auth/login', asyncWrap(async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Supabase is not configured' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password' });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  const account = await ensureAccount(data.user);
  ok(res, { user: publicUser(data.user, account), session: sessionPayload(data.session) });
}));
app.post('/api/auth/refresh', asyncWrap(async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Supabase is not configured' });
  const refreshToken = String(req.body?.refresh_token || '');
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' });
  const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  const account = await ensureAccount(data.user);
  ok(res, { user: publicUser(data.user, account), session: sessionPayload(data.session) });
}));

app.use('/api', requireAuth);
app.get('/api/auth/me', asyncWrap(async (req, res) => ok(res, publicUser(req.authUser, req.authAccount))));
app.post('/api/auth/logout', asyncWrap(async (req, res) => {
  const { error } = await authClient.auth.admin.signOut(req.authToken, 'local');
  if (error) return res.status(400).json({ error: 'Could not end this session' });
  ok(res, { signedOut: true });
}));

// Tasks
app.get('/api/tasks', asyncWrap(async (req, res) => ok(res, await run(db.from('tasks').select('*').eq('user_id', req.userId).order('created_at', { ascending: false })))));
app.get('/api/tasks/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid task id' });
  const row = await run(db.from('tasks').select('*').eq('id', id).eq('user_id', req.userId).maybeSingle());
  return row ? ok(res, row) : notFound(res);
}));
app.post('/api/tasks', asyncWrap(async (req, res) => {
  const row = taskInput(req.body || {});
  if (!validTask(row)) return res.status(400).json({ error: 'Provide a title, valid priority, and target_minutes from 5 to 600' });
  ok(res, await run(db.from('tasks').insert({ ...row, user_id: req.userId }).select().single()), 201);
}));
app.put('/api/tasks/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid task id' });
  const old = await run(db.from('tasks').select('*').eq('id', id).eq('user_id', req.userId).maybeSingle());
  if (!old) return notFound(res);
  const row = taskInput(req.body || {}, old);
  if (!validTask(row)) return res.status(400).json({ error: 'Provide a title, valid priority, and target_minutes from 5 to 600' });
  ok(res, await run(db.from('tasks').update(row).eq('id', id).eq('user_id', req.userId).select().single()));
}));
app.delete('/api/tasks/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid task id' });
  const rows = await run(db.from('tasks').delete().eq('id', id).eq('user_id', req.userId).select('id'));
  return rows.length ? ok(res, { deleted: true }) : notFound(res);
}));

// Focus journal
app.get('/api/journals', asyncWrap(async (req, res) => {
  const rows = await run(db.from('journals').select('*, tasks(title)').eq('user_id', req.userId).order('created_at', { ascending: false }));
  ok(res, withTaskTitle(rows));
}));
app.get('/api/journals/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid journal id' });
  const row = await run(db.from('journals').select('*, tasks(title)').eq('id', id).eq('user_id', req.userId).maybeSingle());
  return row ? ok(res, withTaskTitle([row])[0]) : notFound(res);
}));
app.post('/api/journals', asyncWrap(async (req, res) => {
  const b = req.body || {}, minutes = Number(b.duration_minutes), task = b.task_id ? Number(b.task_id) : null;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return res.status(400).json({ error: 'duration_minutes must be 1–1440' });
  if (task) { const t = await run(db.from('tasks').select('id').eq('id', task).eq('user_id', req.userId).maybeSingle()); if (!t) return res.status(400).json({ error: 'task_id does not belong to this user' }); }
  const row = { user_id: req.userId, task_id: task, title: String(b.title || 'Focus session').slice(0, 150), duration_minutes: minutes, reflection: String(b.reflection || '').slice(0, 4000) };
  if (b.created_at) row.created_at = b.created_at;
  const saved = await run(db.from('journals').insert(row).select('*, tasks(title)').single());
  ok(res, withTaskTitle([saved])[0], 201);
}));
app.put('/api/journals/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid journal id' });
  const old = await run(db.from('journals').select('*').eq('id', id).eq('user_id', req.userId).maybeSingle());
  if (!old) return notFound(res);
  const b = req.body || {}, minutes = Number(b.duration_minutes ?? old.duration_minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return res.status(400).json({ error: 'duration_minutes must be 1–1440' });
  const row = { title: String(b.title ?? old.title).slice(0, 150), duration_minutes: minutes, reflection: String(b.reflection ?? old.reflection).slice(0, 4000) };
  ok(res, withTaskTitle([await run(db.from('journals').update(row).eq('id', id).eq('user_id', req.userId).select('*, tasks(title)').single())])[0]);
}));
app.delete('/api/journals/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid journal id' });
  const rows = await run(db.from('journals').delete().eq('id', id).eq('user_id', req.userId).select('id'));
  return rows.length ? ok(res, { deleted: true }) : notFound(res);
}));

// Soundtrack vault
app.get('/api/soundtracks', asyncWrap(async (req, res) => ok(res, await run(db.from('soundtracks').select('*').eq('user_id', req.userId).order('name')))));
app.get('/api/soundtracks/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid soundtrack id' });
  const row = await run(db.from('soundtracks').select('*').eq('id', id).eq('user_id', req.userId).maybeSingle());
  return row ? ok(res, row) : notFound(res);
}));
app.post('/api/soundtracks', asyncWrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.name !== 'string' || !b.name.trim() || typeof b.url !== 'string' || !b.url.trim()) return res.status(400).json({ error: 'name and url are required' });
  const row = { user_id: req.userId, name: b.name.trim().slice(0, 100), category: String(b.category || 'Ambient').slice(0, 60), description: String(b.description || '').slice(0, 500), url: b.url.slice(0, 1000), favorite: Boolean(b.favorite) };
  ok(res, await run(db.from('soundtracks').insert(row).select().single()), 201);
}));
app.put('/api/soundtracks/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid soundtrack id' });
  const old = await run(db.from('soundtracks').select('*').eq('id', id).eq('user_id', req.userId).maybeSingle());
  if (!old) return notFound(res);
  const b = req.body || {}, row = { name: b.name ?? old.name, category: b.category ?? old.category, description: b.description ?? old.description, url: b.url ?? old.url, favorite: b.favorite === undefined ? old.favorite : Boolean(b.favorite) };
  if (!String(row.name).trim() || !String(row.url).trim()) return res.status(400).json({ error: 'name and url are required' });
  ok(res, await run(db.from('soundtracks').update(row).eq('id', id).eq('user_id', req.userId).select().single()));
}));
app.delete('/api/soundtracks/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid soundtrack id' });
  const rows = await run(db.from('soundtracks').delete().eq('id', id).eq('user_id', req.userId).select('id'));
  return rows.length ? ok(res, { deleted: true }) : notFound(res);
}));
app.post('/api/soundtracks/upload', express.raw({ type: ['audio/mpeg', 'audio/mp3', 'application/octet-stream'], limit: '25mb' }), asyncWrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Upload an MP3 file as the raw request body' });
  const filename = String(req.query.filename || 'my-track.mp3').replace(/[^a-zA-Z0-9._-]/g, '-').slice(-100);
  if (!filename.toLowerCase().endsWith('.mp3')) return res.status(400).json({ error: 'Only MP3 files are supported' });
  const buckets = await run(db.storage.listBuckets());
  const existingBucket = buckets.find(bucket => bucket.name === audioBucket);
  if (!existingBucket) {
    const created = await db.storage.createBucket(audioBucket, { public: true, fileSizeLimit: '25MB', allowedMimeTypes: ['audio/mpeg', 'audio/mp3'] });
    if (created.error && !String(created.error.message).toLowerCase().includes('already exists')) throw created.error;
  } else if (!existingBucket.public) await run(db.storage.updateBucket(audioBucket, { public: true, fileSizeLimit: '25MB', allowedMimeTypes: ['audio/mpeg', 'audio/mp3'] }));
  const storagePath = `${req.userId}/${randomUUID()}-${filename}`;
  const { error: uploadError } = await db.storage.from(audioBucket).upload(storagePath, req.body, { contentType: 'audio/mpeg', cacheControl: '3600', upsert: false });
  if (uploadError) throw uploadError;
  const publicUrl = db.storage.from(audioBucket).getPublicUrl(storagePath).data.publicUrl;
  const title = String(req.query.title || filename.replace(/\.mp3$/i, '')).trim().slice(0, 100);
  const row = { user_id: req.userId, name: title || 'My track', category: 'My music', description: 'Uploaded from your device.', url: publicUrl, favorite: false };
  const { data: saved, error: insertError } = await db.from('soundtracks').insert(row).select().single();
  if (insertError) { await db.storage.from(audioBucket).remove([storagePath]); throw insertError; }
  ok(res, saved, 201);
}));

// One profile per configured user
app.get('/api/profile', asyncWrap(async (req, res) => {
  const row = await run(db.from('users').select('id,username,bio,avatar,avatar_frame,created_at').eq('id', req.userId).maybeSingle());
  return row ? ok(res, row) : notFound(res);
}));
app.put('/api/profile', asyncWrap(async (req, res) => {
  const b = req.body || {}, username = String(b.username || '').trim();
  if (!username || username.length > 80) return res.status(400).json({ error: 'username is required (max 80 characters)' });
  const row = { username, bio: String(b.bio || '').slice(0, 500), avatar: String(b.avatar || '🌙').slice(0, 20), avatar_frame: ['sunny','sky','mint','lavender','peach'].includes(b.avatar_frame) ? b.avatar_frame : 'sunny' };
  const saved = await run(db.from('users').update(row).eq('id', req.userId).select('id,username,bio,avatar,avatar_frame,created_at').maybeSingle());
  return saved ? ok(res, saved) : notFound(res);
}));

// Focus session archive
app.get('/api/focus-sessions', asyncWrap(async (req, res) => {
  const rows = await run(db.from('focus_sessions').select('*, tasks(title)').eq('user_id', req.userId).order('started_at', { ascending: false }));
  ok(res, withTaskTitle(rows));
}));
app.get('/api/focus-sessions/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid focus session id' });
  const row = await run(db.from('focus_sessions').select('*, tasks(title)').eq('id', id).eq('user_id', req.userId).maybeSingle());
  return row ? ok(res, withTaskTitle([row])[0]) : notFound(res);
}));
app.post('/api/focus-sessions', asyncWrap(async (req, res) => {
  const b = req.body || {}, minutes = Number(b.duration_minutes), task = b.task_id ? Number(b.task_id) : null;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return res.status(400).json({ error: 'duration_minutes must be 1–1440' });
  if (task) { const t = await run(db.from('tasks').select('id').eq('id', task).eq('user_id', req.userId).maybeSingle()); if (!t) return res.status(400).json({ error: 'task_id does not belong to this user' }); }
  const row = { user_id: req.userId, task_id: task, duration_minutes: minutes, started_at: b.started_at || null, ended_at: b.ended_at || null };
  ok(res, await run(db.from('focus_sessions').insert(row).select().single()), 201);
}));
app.delete('/api/focus-sessions/:id', asyncWrap(async (req, res) => {
  const id = idOf(req); if (!id) return res.status(400).json({ error: 'Invalid focus session id' });
  const rows = await run(db.from('focus_sessions').delete().eq('id', id).eq('user_id', req.userId).select('id'));
  return rows.length ? ok(res, { deleted: true }) : notFound(res);
}));

app.use((req, res) => res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` }));
app.use((err, _req, res, _next) => {
  console.error(err);
  const unavailable = ['SUPABASE_CONFIG', 'PGRST205', '42P01'].includes(err.code);
  const development = process.env.NODE_ENV !== 'production';
  const error = unavailable
    ? 'Supabase is unavailable or its schema is not initialized'
    : development ? String(err?.message || 'Unexpected backend error') : 'Internal server error';
  res.status(unavailable ? 503 : 500).json({ error, ...(development && err?.code ? { code: err.code } : {}) });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`LofiSpace API listening on http://localhost:${port}`));
