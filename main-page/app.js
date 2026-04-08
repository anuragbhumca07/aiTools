/* ── Stars ── */
(function createStars() {
  const c = document.getElementById('stars');
  for (let i = 0; i < 150; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const size = Math.random() * 2.8 + 0.4;
    s.style.cssText = `width:${size}px;height:${size}px;top:${Math.random()*100}%;left:${Math.random()*100}%;--d:${2+Math.random()*5}s;--delay:${Math.random()*5}s`;
    c.appendChild(s);
  }
})();

/* ── 3D mouse-tilt on cards ── */
document.querySelectorAll('.tool-card:not(.soon)').forEach(card => {
  card.addEventListener('mousemove', e => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width  - 0.5;  // -0.5 to 0.5
    const y = (e.clientY - r.top)  / r.height - 0.5;
    card.style.transform = `
      translateY(-14px)
      rotateX(${-y * 12}deg)
      rotateY(${x * 12}deg)
    `;
  });
  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
  });
});

/* ── Animate stat numbers counting up ── */
function countUp(el, target, duration) {
  const start = performance.now();
  const isNum = !isNaN(target);
  function step(now) {
    const p = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = isNum ? Math.round(ease * target) : '∞';
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    document.querySelectorAll('.stat-num').forEach(el => {
      const t = el.textContent.trim();
      if (t === '∞') return;
      countUp(el, parseInt(t), 1200);
    });
    observer.disconnect();
  });
}, { threshold: 0.5 });

const statsRow = document.querySelector('.stats-row');
if (statsRow) observer.observe(statsRow);

/* ── Stagger card entrance animation ── */
const cards = document.querySelectorAll('.tool-card');
cards.forEach((card, i) => {
  card.style.opacity = '0';
  card.style.transform = 'translateY(40px)';
  card.style.transition = 'opacity .6s ease, transform .6s cubic-bezier(.23,1,.32,1)';
  setTimeout(() => {
    card.style.opacity = '';
    card.style.transform = '';
  }, 100 + i * 80);
});
