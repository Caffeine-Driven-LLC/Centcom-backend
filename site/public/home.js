import { Cento, loadCento } from '/cento.js';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s); const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 30) : ms));
const data = await loadCento();

/* ---------- hero: a scripted session using the real UI vocabulary ---------- */
const feed = $('#feed'), state = $('#hstate'), meter = $('#hmeter'); const hero = new Cento($('#hcento'), data, { px: 7 }); hero.set('idle_breathe');
const label = (n, t) => { hero.set(n); state.innerHTML = t; };
const line = (html) => { const d = document.createElement('div'); d.className = 'tl'; d.innerHTML = html; feed.appendChild(d); feed.parentElement.scrollTop = 1e6; return d; };
async function typeInto(el, text) { for (const ch of text) { el.textContent += ch; await sleep(reduced ? 0 : 28); } }
const DIFF = '<div class="dif"><div class="h">@@ src/auth/session.ts</div><div class="d">- return session.expiresAt &lt; now;</div><div class="a">+ const expiresMs = session.expiresAt * 1000;</div><div class="a">+ return expiresMs &lt;= now;</div></div>';
async function play() {
  feed.innerHTML = ''; meter.style.setProperty('--w', '6%'); label('idle_breathe', 'Ready when you are');
  await sleep(900);
  const u = line('<span class="u">● you</span>  <span class="typed"></span>'); label('typing', '<b>Reading</b> your message'); await typeInto($('.typed', u), 'fix the failing test in the auth module');
  await sleep(500); label('thinking', '<b>Thinking</b>'); line('<span class="m">∴ thought for 2s</span>'); await sleep(1300);
  label('reading_code', '<b>Reading</b> test/auth/session.test.ts'); line('<span class="t">● Read</span>(<span class="path">test/auth/session.test.ts</span>)'); meter.style.setProperty('--w', '22%'); await sleep(700); line('<span class="m">└ 88 lines</span>'); await sleep(900);
  line('Found it: <code>expiresAt</code> is in seconds, but <code>isExpired</code> compares it with <code>Date.now()</code>.'); await sleep(1100);
  line('<span class="t">● Edit</span>(<span class="path">src/auth/session.ts</span>)'); line(DIFF); await sleep(500);
  const a = line('<div class="apr"><b>? Change this file?</b> <span class="m">medium risk</span><div class="keys"><kbd>y</kbd> allow · <kbd>a</kbd> always this session · <kbd>n</kbd> decline</div></div>');
  label('tool_approve', '<b>Waiting for you</b>'); meter.style.setProperty('--w', '38%'); await sleep(2600);
  a.innerHTML = '<div class="apr"><b style="color:var(--ok)">✓ Allowed</b> <span class="m">you pressed y</span></div>'; label('running_command', '<b>Running</b> pnpm test auth'); await sleep(700);
  line('<span class="t">● Bash</span>(<span class="path">pnpm test auth</span>)'); meter.style.setProperty('--w', '57%'); await sleep(1500); line('<span class="ok">└ 12 passed</span>'); await sleep(500);
  line('All 12 tests pass. <code>isExpired</code> now converts seconds to milliseconds.'); label('celebrate', '<b>Done</b>'); meter.style.setProperty('--w', '64%');
  await sleep(reduced ? 0 : 5200); if (!reduced) play();
}
if (reduced) { play(); } else { const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); play(); } }, { threshold: 0.2 }); io.observe($('.term')); }

/* ---------- story: Cento's state follows the beats ---------- */
const pin = new Cento($('#pin'), data, { px: 10 }); pin.set('look_around');
const beats = [...document.querySelectorAll('.beat')]; const cap = $('#pincap');
const so = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { beats.forEach((b) => b.classList.toggle('on', b === e.target)); pin.set(e.target.dataset.anim); cap.textContent = e.target.dataset.cap; } }, { rootMargin: '-45% 0px -45% 0px' });
beats.forEach((b) => so.observe(b));

/* ---------- reveal on scroll ---------- */
const ro = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); } }), { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => ro.observe(el));

/* ---------- footer Cento ---------- */
const f = $('#fcento'); if (f) new Cento(f, data, { px: 4 }).set('wave');
