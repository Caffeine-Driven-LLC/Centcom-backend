import { Cento, loadCento } from '/cento.js';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const links = $$('.toc a[href^="#"]'); const secs = $$('.doc section[id]');

/* scroll-spy */
const spy = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id)); }, { rootMargin: '-20% 0px -70% 0px' });
secs.forEach((s) => spy.observe(s));

/* search: filters the contents list by section text */
const text = new Map(secs.map((s) => [s.id, s.textContent.toLowerCase()]));
$('#q')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase(); let first = null;
  links.forEach((a) => { const id = a.getAttribute('href').slice(1); const hit = !q || (text.get(id) ?? '').includes(q) || a.textContent.toLowerCase().includes(q); a.hidden = !hit; if (hit && q && !first) first = id; });
  $$('.toc h5').forEach((h) => { let n = h.nextElementSibling, any = false; while (n && n.tagName === 'A') { if (!n.hidden) any = true; n = n.nextElementSibling; } h.hidden = !any; });
  $('#nohit').hidden = !q || links.some((a) => !a.hidden);
});
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); $('#q')?.focus(); } });

/* copy buttons */
$$('.doc pre').forEach((p) => { const b = document.createElement('button'); b.className = 'copy'; b.textContent = 'Copy'; b.setAttribute('aria-label', 'Copy code'); b.onclick = async () => { try { await navigator.clipboard.writeText(p.innerText.replace(/Copy$/, '').trim()); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); } catch { b.textContent = 'Press Ctrl+C'; } }; p.appendChild(b); });

const f = $('#fcento'); if (f) { const d = await loadCento(); new Cento(f, d, { px: 4 }).set('wave'); }
